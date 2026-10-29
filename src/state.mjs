import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { acquireProcessLease } from "./process-lease.mjs";
import { assertResetNotRunning } from "./reset-guard.mjs";

const iso = () => new Date().toISOString();
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameLink = (left, right) => {
  if (left?.linkId && right?.linkId) return left.linkId === right.linkId;
  return left?.topicId === right?.topicId;
};

function validateState(value) {
  if (!object(value) || value.version !== 1 || !object(value.telegram)
    || !object(value.projects) || !Array.isArray(value.approvals)
    || Object.values(value.projects).some((project) => !object(project))
    || value.approvals.some((approval) => !object(approval) || typeof approval.id !== "string")) {
    throw new Error("Invalid or unsupported LocalCodeLink state. Keep a backup and restore a compatible state/release; do not reset automatically.");
  }
  return value;
}

function parseState(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("LocalCodeLink state is not valid JSON. Preserve it for recovery; no state was overwritten."); }
  return validateState(value);
}

// Apply only this process's changes to the latest disk state. CLI launches,
// approval hooks, and the Telegram daemon are independent concurrent writers.
function mergeChanges(base, local, current) {
  if (equal(base, local)) return current;
  // A stale hook/task must not recreate a record removed by unlink.
  if (base !== undefined && current === undefined) return undefined;
  if (object(local) && (!base || object(base)) && (!current || object(current))) {
    if (base === undefined && local.id && current?.id === local.id) return current;
    // Re-linking a deleted project creates a new topic/link generation.
    if (base?.id && current?.id === base.id && !sameLink(base, current)) return current;
    if (base?.status === "pending" && current?.status !== "pending"
      && local.status !== current.status && base?.projectId) return current;
    if (["pending", "expired"].includes(base?.status) && current?.status === "responding"
      && local.claimId && local.claimId !== current.claimId) return current;
    const result = { ...(current || {}) };
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local)])) {
      if (!(key in local)) {
        if (key in (base || {})) delete result[key];
      } else {
        const value = mergeChanges(base?.[key], local[key], current?.[key]);
        if (value === undefined) delete result[key];
        else result[key] = value;
      }
    }
    // Unlink wins over an in-flight completion that still thinks the project
    // is busy. Restoring access requires observing the unlinked state first.
    if (current?.status === "unlinked" && base?.status !== "unlinked") {
      result.status = "unlinked";
    }
    return result;
  }
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(current)
    && [...base, ...local, ...current].every((item) => object(item) && typeof item.id === "string")) {
    const baseById = new Map(base.map((item) => [item.id, item]));
    const localById = new Map(local.map((item) => [item.id, item]));
    const currentById = new Map(current.map((item) => [item.id, item]));
    for (const id of baseById.keys()) if (!localById.has(id)) currentById.delete(id);
    for (const [id, item] of localById) {
      const before = baseById.get(id);
      if (before && !currentById.has(id)) continue;
      if (!equal(before, item)) currentById.set(id, mergeChanges(before, item, currentById.get(id)));
    }
    return [...currentById.values()];
  }
  return local;
}

export class StateStore {
  constructor(root = process.env.LOCAL_CODE_LINK_HOME || path.join(os.homedir(), ".local-code-link")) {
    this.root = path.resolve(root);
    if ([path.parse(this.root).root, os.homedir()].includes(this.root)) {
      throw new Error("LOCAL_CODE_LINK_HOME must be a dedicated state directory, not a filesystem root or home directory.");
    }
    this.file = path.join(this.root, "state.json");
    this.state = null;
    this.baseline = null;
    this.saving = Promise.resolve();
  }

  async init() {
    await assertResetNotRunning(this.root);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.state = parseState(await readFile(this.file, "utf8"));
      this.baseline = structuredClone(this.state);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.state = {
        version: 1,
        createdAt: iso(),
        telegram: {},
        projects: {},
        approvals: [],
      };
      await this.save();
    }
    return this;
  }

  async reload() {
    let next;
    while (true) {
      const saving = this.saving;
      await saving;
      next = parseState(await readFile(this.file, "utf8"));
      // A second save can begin while this read is in flight. Never apply
      // that older snapshot over newer in-memory mutations captured by it.
      if (this.saving === saving) break;
    }
    this.baseline = structuredClone(next);
    if (!this.state) {
      this.state = next;
      return this.state;
    }

    this.state.version = next.version;
    this.state.createdAt = next.createdAt;
    this.state.telegram = next.telegram;
    const approvalsById = new Map(this.state.approvals.map((approval) => [approval.id, approval]));
    this.state.approvals = next.approvals.map((approval) => {
      const existing = approvalsById.get(approval.id);
      if (!existing) return approval;
      for (const key of Object.keys(existing)) if (!(key in approval)) delete existing[key];
      Object.assign(existing, approval);
      return existing;
    });
    this.state.projects ||= {};
    for (const id of Object.keys(this.state.projects)) {
      if (!next.projects[id]) {
        // In-flight callers may retain this reference after it leaves the map.
        this.state.projects[id].status = "unlinked";
        delete this.state.projects[id];
      }
    }
    for (const [id, project] of Object.entries(next.projects)) {
      if (this.state.projects[id] && sameLink(this.state.projects[id], project)) {
        for (const key of Object.keys(this.state.projects[id])) {
          if (!(key in project)) delete this.state.projects[id][key];
        }
        Object.assign(this.state.projects[id], project);
      }
      else {
        if (this.state.projects[id]) this.state.projects[id].status = "unlinked";
        this.state.projects[id] = project;
      }
    }
    return this.state;
  }

  async save() {
    const desired = structuredClone(this.state);
    const baseline = structuredClone(this.baseline);
    const task = this.saving.then(async () => {
      const lockFile = `${this.file}.lock`;
      const deadline = Date.now() + 10_000;
      let release;
      while (true) {
        try {
          release = await acquireProcessLease(lockFile);
          break;
        } catch (error) {
          if (error.code !== "LCL_LOCKED") throw error;
          if (Date.now() >= deadline) throw new Error("LocalCodeLink state is busy; please retry");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      try {
        await assertResetNotRunning(this.root);
        let current = null;
        try {
          current = parseState(await readFile(this.file, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const merged = mergeChanges(baseline, desired, current);
        // Concurrent late approval inserts cannot retain history for a removed
        // project or attach an old topic's request to a newly re-linked project.
        merged.approvals = merged.approvals.filter((approval) => {
          if (!approval.projectId) return true;
          const project = merged.projects[approval.projectId];
          return project && (approval.topicId === undefined
            || Number(approval.topicId) === Number(project.topicId));
        });
        const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
        validateState(merged);
        try {
          const file = await open(temporary, "wx", 0o600);
          try {
            await file.writeFile(`${JSON.stringify(merged, null, 2)}\n`);
            await file.sync();
          } finally { await file.close(); }
          await rename(temporary, this.file);
          // Atomic rename prevents partial readers; syncing the directory
          // additionally persists the new name across a host/power crash.
          const directory = await open(this.root, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        } finally {
          try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
        // Baseline tracks what this process observed, not unseen changes from
        // other writers. A later save must not treat those as local deletions.
        this.baseline = desired;
      } finally {
        await release();
      }
    });
    this.saving = task.catch(() => {});
    return task;
  }

  async forgetProject(projectId) {
    await this.reload();
    const project = this.state.projects[projectId];
    if (project) project.status = "unlinked";
    delete this.state.projects[projectId];
    this.state.approvals = this.state.approvals.filter((approval) => approval.projectId !== projectId);
    await this.save();
  }
}

export function publicProject(project) {
  return { ...project };
}

export function slug(value) {
  const result = String(value).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) throw new Error("Project name must contain letters or numbers");
  return result;
}

export function now() {
  return iso();
}
