export const meta = {
  apiVersion: 1,
  key: "telecom-wan3",
  name: "中国电信 Wan 3",
  description: { zh: "中国电信网关 Wan 3 视频生成", en: "Wan 3 video generation through China Telecom" },
  version: "1.0.2",
  author: { name: "AllinHub" },
  models: ["wan3.0-video"],
  fetchMode: "per_task",
  upstreams: ["vendor"],
  protocols: ["openai_video"],
  usageSchema: {
    seconds: { type: "number", unit: "second" },
    resolution: { enum: ["480P", "720P", "1080P"] },
  },
};

const submitPath = "/v1/videos/generations";

function baseURL(ctx) {
  return ctx.baseUrl.replace(/\/+$/, "");
}

function authorization(ctx) {
  return { Authorization: "Bearer " + ctx.apiKey };
}

export function buildSubmitRequest(ctx) {
  const req = ctx.requestBody;
  const input = Object.assign({}, req.input);
  const parameters = Object.assign({}, req.parameters);
  input.prompt = input.prompt ?? req.prompt;
  parameters.duration = Number(parameters.duration ?? req.seconds ?? req.duration ?? 5);
  parameters.ratio = parameters.ratio ?? req.ratio ?? "16:9";
  parameters.resolution = String(parameters.resolution ?? req.resolution ?? "720P").toUpperCase();
  if (!Number.isInteger(parameters.duration)) throw new Error("duration must be an integer");
  if (!(typeof input.prompt === "string" && input.prompt.trim()) && !(Array.isArray(input.media) && input.media.length)) {
    throw new Error("prompt or input.media is required");
  }
  return {
    url: baseURL(ctx) + submitPath,
    method: "POST",
    headers: Object.assign(authorization(ctx), { "Content-Type": "application/json" }),
    body: { model: ctx.upstreamModel, input, parameters },
  };
}

export function extractUsage(ctx) {
  const parameters = buildSubmitRequest(ctx).body.parameters;
  return { seconds: parameters.duration === -1 ? 30 : parameters.duration, resolution: parameters.resolution };
}

export function parseSubmitResponse(ctx, resp) {
  const body = resp.body || {};
  if (body.code) throw new Error(body.code + ": " + (body.message || ""));
  const taskId = (body.output || {}).task_id;
  if (!taskId) throw new Error("missing output.task_id");
  return { taskId, taskData: body };
}

export function buildQueryRequest(ctx) {
  return {
    url: baseURL(ctx) + submitPath + "/task/" + encodeURIComponent(ctx.taskId),
    method: "GET",
    headers: authorization(ctx),
  };
}

export function parseTaskResult(ctx, body) {
  const output = body.output || {};
  switch (output.task_status) {
    case "PENDING":
      return { status: "QUEUED" };
    case "RUNNING":
      return { status: "IN_PROGRESS" };
    case "SUCCEEDED":
      if (output.video_url) return { status: "SUCCESS", url: output.video_url };
      return { status: "FAILURE", reason: "missing output.video_url" };
    case "FAILED":
    case "CANCELED":
    case "UNKNOWN":
      return { status: "FAILURE", reason: output.message || body.message || output.code || body.code || output.task_status };
    default:
      if (body.code) return { status: "FAILURE", reason: body.message || body.code };
      return { status: "UNKNOWN", reason: "unrecognized status: " + String(output.task_status || "") };
  }
}

function videoURL(ctx) {
  let data = ctx.data || {};
  if (data.data && data.data.task_id) data = data.data.data || {};
  return (data.output || {}).video_url;
}

export function listArtifacts(task) {
  return task.status === "SUCCESS" && videoURL(task) ? [{ key: "video", type: "video" }] : [];
}

export function buildContentRequest(ctx) {
  const url = videoURL(ctx);
  if (ctx.artifactKey !== "video" || !url) throw new Error("artifact_not_found");
  return { url, method: ctx.clientRequest.method, credentialless: true };
}

export const protocols = {
  openai_video: {
    decodeRequest(ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const req = ctx.body.value;
      if (!req || typeof req !== "object" || Array.isArray(req)) throw new Error("JSON object required");
      for (const field of ["input", "parameters"]) {
        const value = req[field];
        if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
          throw new Error(field + " must be an object");
        }
      }
      return { kind: "submit", model: ctx.model, action: "generate", requestBody: req };
    },
    render(ctx, task) {
      const statuses = { QUEUED: "queued", IN_PROGRESS: "in_progress", SUCCESS: "completed", FAILURE: "failed" };
      const result = {
        id: task.task_id,
        object: "video",
        model: (task.properties || {}).origin_model_name || "wan3.0-video",
        status: statuses[task.status] || "queued",
        progress: Number(String(task.progress || "0").replace("%", "")),
        created_at: task.created_at,
      };
      if (task.status === "SUCCESS") {
        result.completed_at = task.updated_at;
        const url = videoURL(task);
        if (url) result.video_url = url;
      }
      if (task.status === "FAILURE") result.error = { message: task.fail_reason || "video generation failed" };
      return result;
    },
  },
};
