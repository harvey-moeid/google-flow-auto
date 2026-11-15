import { HttpError, jsonResponse, readJsonObject } from "./http.ts";
import { isUniqueViolation, page, parsePagination } from "./paging.ts";
import { auditStatement } from "./route-types.ts";
import type { Ctx, Route } from "./route-types.ts";
import {
  ACCOUNT_ID_RE,
  ASPECT_RATIOS,
  ENGINES,
  Issues,
  MAX_SCENES_PER_PROJECT,
  PROJECT_STATUSES,
  PROMPT_MAX_LENGTH,
  SCENE_DURATION_MAX_S,
  SCENE_DURATION_MIN_S,
  readEnum,
  readInt,
  readString,
  readUuidList,
  rejectUnknownFields,
} from "./validate.ts";

/** A job in one of these states still owns (or will soon run) its scene, so the scene must not change. */
const ACTIVE_JOB = "status IN ('queued','claimed','running','waiting_for_user')";
const KEY_RE = /^[A-Za-z0-9._:-]+$/;
/** Order offset used while renumbering, so UNIQUE(project_id, scene_order) never collides mid-update. */
const REORDER_OFFSET = 1000;

const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const projectPath = (suffix = "") => new RegExp(`^/api/projects/(${UUID_PATTERN})${suffix}$`);
const SCENE_PATH = new RegExp(`^/api/scenes/(${UUID_PATTERN})$`);
const SCENE_DELETE_PATH = new RegExp(`^/api/scenes/(${UUID_PATTERN})/delete$`);

interface ProjectRow {
  id: string;
  name: string;
  aspect_ratio: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SceneRow {
  id: string;
  project_id: string;
  scene_order: number;
  prompt: string;
  duration_seconds: number;
  created_at: string;
  updated_at: string;
}

const internal = () => new HttpError(500, "internal_error", "Internal error");

async function loadProject(ctx: Ctx, id: string): Promise<ProjectRow> {
  const project = await ctx.env.DB.prepare(
    "SELECT id,name,aspect_ratio,status,created_at,updated_at FROM projects WHERE id=?",
  )
    .bind(id)
    .first<ProjectRow>();
  if (!project) throw new HttpError(404, "project_not_found", "Project not found");
  return project;
}

function requireEditable(project: { status: string }): void {
  if (project.status === "archived") {
    throw new HttpError(409, "project_archived", "Archived projects cannot be changed; restore the project first");
  }
}

async function hasActiveJob(ctx: Ctx, column: "scene_id" | "project_id", id: string): Promise<boolean> {
  const row = await ctx.env.DB.prepare(`SELECT 1 AS busy FROM jobs WHERE ${column}=? AND ${ACTIVE_JOB} LIMIT 1`)
    .bind(id)
    .first();
  return row !== null;
}

const touchProject = (ctx: Ctx, projectId: string) =>
  ctx.env.DB.prepare("UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(projectId);

// ---------- projects ----------

const LIST_STATUSES = [...PROJECT_STATUSES, "all"] as const;

async function listProjects(ctx: Ctx): Promise<Response> {
  const { limit, cursor } = parsePagination(ctx.url);
  const issues = new Issues();
  const rawStatus = ctx.url.searchParams.get("status");
  const status =
    rawStatus === null ? "draft" : (readEnum({ status: rawStatus }, "status", LIST_STATUSES, issues) ?? "draft");
  issues.throwIfAny();

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (status !== "all") {
    conditions.push("p.status = ?");
    binds.push(status);
  }
  if (cursor) {
    conditions.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    binds.push(cursor[0], cursor[0], cursor[1]);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { results } = await ctx.env.DB.prepare(
    `SELECT p.id,p.name,p.aspect_ratio,p.status,p.created_at,p.updated_at,
            (SELECT COUNT(*) FROM scenes s WHERE s.project_id=p.id) AS scene_count
       FROM projects p ${where}
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{ id: string; created_at: string }>();
  return jsonResponse(page(results, limit));
}

async function getProject(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const project = await loadProject(ctx, id);
  const { results } = await ctx.env.DB.prepare(
    `SELECT s.id,s.scene_order,s.prompt,s.duration_seconds,s.created_at,s.updated_at,
            (SELECT j.id FROM jobs j WHERE j.scene_id=s.id ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS last_job_id,
            (SELECT j.status FROM jobs j WHERE j.scene_id=s.id ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS last_job_status
       FROM scenes s WHERE s.project_id=? ORDER BY s.scene_order`,
  )
    .bind(id)
    .all<{
      id: string;
      scene_order: number;
      prompt: string;
      duration_seconds: number;
      created_at: string;
      updated_at: string;
      last_job_id: string | null;
      last_job_status: string | null;
    }>();
  const scenes = results.map(({ last_job_id, last_job_status, ...scene }) => ({
    ...scene,
    last_job: last_job_id ? { id: last_job_id, status: last_job_status } : null,
  }));
  return jsonResponse({
    ...project,
    scene_count: scenes.length,
    total_seconds: scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0),
    scenes,
  });
}

async function patchProject(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["name", "aspect_ratio", "status"], issues);
  const name = readString(body, "name", { max: 120 }, issues);
  const aspectRatio = readEnum(body, "aspect_ratio", ASPECT_RATIOS, issues);
  const status = readEnum(body, "status", PROJECT_STATUSES, issues);
  if (body.name === undefined && body.aspect_ratio === undefined && body.status === undefined) {
    issues.add("$", "empty_update");
  }
  issues.throwIfAny();

  const project = await loadProject(ctx, id);
  const changesContent = name !== undefined || aspectRatio !== undefined;
  if (project.status === "archived" && changesContent) requireEditable(project);

  const archiving = status === "archived" && project.status !== "archived";
  const changesRatio = aspectRatio !== undefined && aspectRatio !== project.aspect_ratio;
  if ((archiving || changesRatio) && (await hasActiveJob(ctx, "project_id", id))) {
    throw new HttpError(409, "project_busy", "The project has jobs that are queued or running");
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const fields: string[] = [];
  if (name !== undefined) {
    sets.push("name=?");
    binds.push(name);
    fields.push("name");
  }
  if (aspectRatio !== undefined) {
    sets.push("aspect_ratio=?");
    binds.push(aspectRatio);
    fields.push("aspect_ratio");
  }
  if (status !== undefined) {
    sets.push("status=?");
    binds.push(status);
    fields.push("status");
  }
  sets.push("updated_at=CURRENT_TIMESTAMP");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE projects SET ${sets.join(",")} WHERE id=?`).bind(...binds, id),
    auditStatement(ctx, "project.updated", {}, { project_id: id, fields, ...(status ? { status } : {}) }),
  ]);
  return jsonResponse(await loadProject(ctx, id));
}

// ---------- scenes ----------

async function createScene(ctx: Ctx): Promise<Response> {
  const projectId = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["prompt", "duration_seconds"], issues);
  const prompt = readString(body, "prompt", { required: true, max: PROMPT_MAX_LENGTH, multiline: true }, issues);
  const duration = readInt(
    body,
    "duration_seconds",
    { min: SCENE_DURATION_MIN_S, max: SCENE_DURATION_MAX_S },
    issues,
  );
  issues.throwIfAny();
  if (prompt === undefined) throw internal();

  const project = await loadProject(ctx, projectId);
  requireEditable(project);
  const { n } = (await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM scenes WHERE project_id=?")
    .bind(projectId)
    .first<{ n: number }>()) ?? { n: 0 };
  if (n >= MAX_SCENES_PER_PROJECT) {
    throw new HttpError(409, "scene_limit_reached", "The project already has the maximum number of scenes", {
      max: MAX_SCENES_PER_PROJECT,
    });
  }

  const id = crypto.randomUUID();
  const statements = () => [
    ctx.env.DB.prepare(
      `INSERT INTO scenes(id,project_id,scene_order,prompt,duration_seconds)
       SELECT ?,?,COALESCE(MAX(scene_order),0)+1,?,? FROM scenes WHERE project_id=?`,
    ).bind(id, projectId, prompt, duration ?? 8, projectId),
    touchProject(ctx, projectId),
    auditStatement(ctx, "scene.created", {}, { project_id: projectId, scene_id: id }),
  ];
  try {
    await ctx.env.DB.batch(statements());
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race for the next order number: one retry recomputes it.
    await ctx.env.DB.batch(statements());
  }
  const scene = await ctx.env.DB.prepare(
    "SELECT id,project_id,scene_order,prompt,duration_seconds,created_at,updated_at FROM scenes WHERE id=?",
  )
    .bind(id)
    .first<SceneRow>();
  return jsonResponse(scene, 201);
}

async function loadScene(ctx: Ctx, id: string): Promise<SceneRow & { project_status: string }> {
  const scene = await ctx.env.DB.prepare(
    `SELECT s.id,s.project_id,s.scene_order,s.prompt,s.duration_seconds,s.created_at,s.updated_at,
            p.status AS project_status
       FROM scenes s JOIN projects p ON p.id=s.project_id WHERE s.id=?`,
  )
    .bind(id)
    .first<SceneRow & { project_status: string }>();
  if (!scene) throw new HttpError(404, "scene_not_found", "Scene not found");
  return scene;
}

async function patchScene(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["prompt", "duration_seconds"], issues);
  const prompt = readString(body, "prompt", { max: PROMPT_MAX_LENGTH, multiline: true }, issues);
  const duration = readInt(
    body,
    "duration_seconds",
    { min: SCENE_DURATION_MIN_S, max: SCENE_DURATION_MAX_S },
    issues,
  );
  if (body.prompt === undefined && body.duration_seconds === undefined) issues.add("$", "empty_update");
  issues.throwIfAny();

  const scene = await loadScene(ctx, id);
  requireEditable({ status: scene.project_status });
  if (await hasActiveJob(ctx, "scene_id", id)) {
    throw new HttpError(409, "scene_locked", "The scene has a job that is queued or running");
  }

  const sets: string[] = [];
  const binds: unknown[] = [];
  const fields: string[] = [];
  if (prompt !== undefined) {
    sets.push("prompt=?");
    binds.push(prompt);
    fields.push("prompt");
  }
  if (duration !== undefined) {
    sets.push("duration_seconds=?");
    binds.push(duration);
    fields.push("duration_seconds");
  }
  sets.push("updated_at=CURRENT_TIMESTAMP");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE scenes SET ${sets.join(",")} WHERE id=?`).bind(...binds, id),
    touchProject(ctx, scene.project_id),
    // Field names only: prompts can be long and are not copied into the audit log.
    auditStatement(ctx, "scene.updated", {}, { project_id: scene.project_id, scene_id: id, fields }),
  ]);
  const row = await ctx.env.DB.prepare(
    "SELECT id,project_id,scene_order,prompt,duration_seconds,created_at,updated_at FROM scenes WHERE id=?",
  )
    .bind(id)
    .first<SceneRow>();
  return jsonResponse(row);
}

async function deleteScene(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const scene = await loadScene(ctx, id);
  requireEditable({ status: scene.project_status });
  if (await hasActiveJob(ctx, "scene_id", id)) {
    throw new HttpError(409, "scene_locked", "The scene has a job that is queued or running");
  }
  // Finished jobs stay in the history (jobs.scene_id becomes NULL through the foreign key).
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM scenes WHERE id=?").bind(id),
    touchProject(ctx, scene.project_id),
    auditStatement(ctx, "scene.deleted", {}, { project_id: scene.project_id, scene_id: id }),
  ]);
  return jsonResponse({ id, deleted: true });
}

async function reorderScenes(ctx: Ctx): Promise<Response> {
  const projectId = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["scene_ids"], issues);
  const ids = readUuidList(body, "scene_ids", MAX_SCENES_PER_PROJECT, issues);
  issues.throwIfAny();
  if (!ids) throw internal();

  const project = await loadProject(ctx, projectId);
  requireEditable(project);
  const { results } = await ctx.env.DB.prepare("SELECT id FROM scenes WHERE project_id=?")
    .bind(projectId)
    .all<{ id: string }>();
  const existing = new Set(results.map((row) => row.id));
  if (existing.size !== ids.length || !ids.every((id) => existing.has(id))) {
    throw new HttpError(409, "scene_set_mismatch", "scene_ids must list every scene of the project exactly once", {
      expected: existing.size,
      received: ids.length,
    });
  }

  await ctx.env.DB.batch([
    // Park every scene above the target range first, then assign 1..N, so the UNIQUE index never trips.
    ctx.env.DB.prepare("UPDATE scenes SET scene_order=scene_order+? WHERE project_id=?").bind(REORDER_OFFSET, projectId),
    ...ids.map((id, index) =>
      ctx.env.DB.prepare("UPDATE scenes SET scene_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?").bind(
        index + 1,
        id,
        projectId,
      ),
    ),
    touchProject(ctx, projectId),
    auditStatement(ctx, "scene.reordered", {}, { project_id: projectId, count: ids.length }),
  ]);
  return jsonResponse({ project_id: projectId, scene_ids: ids });
}

// ---------- readiness and submission ----------

interface Problem {
  code: string;
  scene_id?: string;
}

interface AccountSummary {
  id: string;
  slot: number;
  label: string;
  status: string;
}

async function collectProblems(
  ctx: Ctx,
  project: ProjectRow,
  scenes: Array<{ id: string }>,
  accountId: string | undefined,
): Promise<{ problems: Problem[]; account: AccountSummary | null }> {
  const problems: Problem[] = [];
  if (project.status === "archived") problems.push({ code: "project_archived" });
  if (scenes.length === 0) problems.push({ code: "no_scenes" });

  let account: AccountSummary | null = null;
  if (accountId === undefined) {
    problems.push({ code: "account_required" });
  } else {
    account = await ctx.env.DB.prepare("SELECT id,slot,label,status FROM accounts WHERE id=?")
      .bind(accountId)
      .first<AccountSummary>();
    if (!account) problems.push({ code: "account_not_found" });
    else if (account.status !== "ready") problems.push({ code: "account_not_ready" });
  }

  const { results } = await ctx.env.DB.prepare(
    `SELECT DISTINCT scene_id FROM jobs WHERE project_id=? AND scene_id IS NOT NULL AND ${ACTIVE_JOB}`,
  )
    .bind(project.id)
    .all<{ scene_id: string }>();
  for (const row of results) problems.push({ code: "scene_busy", scene_id: row.scene_id });
  return { problems, account };
}

async function readiness(ctx: Ctx): Promise<Response> {
  const id = ctx.params[0].toLowerCase();
  const issues = new Issues();
  const rawAccount = ctx.url.searchParams.get("account_id");
  const accountId =
    rawAccount === null
      ? undefined
      : readString({ account_id: rawAccount }, "account_id", { max: 8, pattern: ACCOUNT_ID_RE }, issues);
  issues.throwIfAny();

  const project = await loadProject(ctx, id);
  const { results: scenes } = await ctx.env.DB.prepare(
    "SELECT id,duration_seconds FROM scenes WHERE project_id=? ORDER BY scene_order",
  )
    .bind(id)
    .all<{ id: string; duration_seconds: number }>();
  const { problems, account } = await collectProblems(ctx, project, scenes, accountId);
  const { results: ready } = await ctx.env.DB.prepare(
    "SELECT id,slot,label FROM accounts WHERE status='ready' ORDER BY slot",
  ).all();
  return jsonResponse({
    project_id: id,
    aspect_ratio: project.aspect_ratio,
    scene_count: scenes.length,
    total_seconds: scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0),
    account,
    ready_accounts: ready,
    problems,
    can_submit: problems.length === 0,
  });
}

interface SubmittedJob {
  id: string;
  scene_id: string | null;
  account_id: string;
  engine: string;
  status: string;
}

async function submitProject(ctx: Ctx): Promise<Response> {
  const projectId = ctx.params[0].toLowerCase();
  const body = await readJsonObject(ctx.req);
  const issues = new Issues();
  rejectUnknownFields(body, ["account_id", "engine", "idempotency_key", "expected_scene_count"], issues);
  const accountId = readString(body, "account_id", { required: true, max: 8, pattern: ACCOUNT_ID_RE }, issues);
  const engine = readEnum(body, "engine", ENGINES, issues) ?? "dry-run";
  const key = readString(body, "idempotency_key", { required: true, min: 8, max: 64, pattern: KEY_RE }, issues);
  const expected = readInt(
    body,
    "expected_scene_count",
    { required: true, min: 1, max: MAX_SCENES_PER_PROJECT },
    issues,
  );
  issues.throwIfAny();
  if (accountId === undefined || key === undefined || expected === undefined) throw internal();

  if (engine !== "dry-run" && !ctx.cfg.liveEnginesEnabled) {
    throw new HttpError(403, "live_engine_disabled", "Live engines are disabled; use the dry-run engine");
  }

  const project = await loadProject(ctx, projectId);
  const { results: scenes } = await ctx.env.DB.prepare("SELECT id,scene_order FROM scenes WHERE project_id=? ORDER BY scene_order")
    .bind(projectId)
    .all<{ id: string; scene_order: number }>();

  // One job per scene, keyed `<key>:<scene id>`, so a repeated tap on "Submit" never queues twice.
  const keyFor = (sceneId: string) => `${key}:${sceneId}`;
  const findExisting = async (): Promise<SubmittedJob[]> => {
    if (scenes.length === 0) return [];
    const marks = scenes.map(() => "?").join(",");
    const { results } = await ctx.env.DB.prepare(
      `SELECT id,scene_id,account_id,engine,status FROM jobs WHERE project_id=? AND idempotency_key IN (${marks})`,
    )
      .bind(projectId, ...scenes.map((scene) => keyFor(scene.id)))
      .all<SubmittedJob>();
    return results;
  };
  const replay = (existing: SubmittedJob[]): Response => {
    const same =
      existing.length === scenes.length && existing.every((job) => job.account_id === accountId && job.engine === engine);
    if (!same) {
      throw new HttpError(409, "idempotency_key_conflict", "Idempotency key was already used with different parameters");
    }
    const order = new Map(scenes.map((scene) => [scene.id, scene.scene_order]));
    const jobs = [...existing]
      .sort((a, b) => (order.get(a.scene_id ?? "") ?? 0) - (order.get(b.scene_id ?? "") ?? 0))
      .map((job) => ({ id: job.id, scene_id: job.scene_id, status: job.status }));
    return jsonResponse({ project_id: projectId, jobs, idempotent_replay: true }, 200);
  };

  const already = await findExisting();
  if (already.length > 0) return replay(already);

  if (scenes.length !== expected) {
    throw new HttpError(409, "scenes_changed", "The scenes changed since the review; review the project again", {
      expected,
      actual: scenes.length,
    });
  }
  const { problems } = await collectProblems(ctx, project, scenes, accountId);
  if (problems.length > 0) {
    throw new HttpError(409, "submit_blocked", "The project is not ready to submit", { problems });
  }

  const created = scenes.map((scene) => ({ id: crypto.randomUUID(), scene }));
  try {
    await ctx.env.DB.batch([
      // Inserted in scene order: the global lane runs jobs FIFO by creation (created_at, rowid).
      ...created.flatMap(({ id, scene }) => [
        ctx.env.DB.prepare(
          "INSERT INTO jobs(id,project_id,scene_id,account_id,engine,status,idempotency_key) VALUES(?,?,?,?,?,'queued',?)",
        ).bind(id, projectId, scene.id, accountId, engine, keyFor(scene.id)),
        auditStatement(ctx, "job.queued", { account_id: accountId, job_id: id }, {
          project_id: projectId,
          scene_id: scene.id,
          engine,
        }),
      ]),
      auditStatement(ctx, "project.submitted", { account_id: accountId }, {
        project_id: projectId,
        scene_count: scenes.length,
        engine,
      }),
    ]);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findExisting();
    if (raced.length > 0) return replay(raced);
    throw error;
  }
  return jsonResponse(
    {
      project_id: projectId,
      jobs: created.map(({ id, scene }) => ({ id, scene_id: scene.id, scene_order: scene.scene_order, status: "queued" })),
    },
    201,
  );
}

// ---------- route table ----------

export const projectRoutes: Route[] = [
  { method: "GET", pattern: /^\/api\/projects$/, write: false, audience: "owner", handler: listProjects },
  { method: "GET", pattern: projectPath(), write: false, audience: "owner", handler: getProject },
  { method: "PATCH", pattern: projectPath(), write: true, audience: "owner", handler: patchProject },
  { method: "POST", pattern: projectPath("/scenes"), write: true, audience: "owner", handler: createScene },
  { method: "POST", pattern: projectPath("/scenes/reorder"), write: true, audience: "owner", handler: reorderScenes },
  { method: "GET", pattern: projectPath("/readiness"), write: false, audience: "owner", handler: readiness },
  { method: "POST", pattern: projectPath("/submit"), write: true, audience: "owner", handler: submitProject },
  { method: "PATCH", pattern: SCENE_PATH, write: true, audience: "owner", handler: patchScene },
  { method: "POST", pattern: SCENE_DELETE_PATH, write: true, audience: "owner", handler: deleteScene },
];
