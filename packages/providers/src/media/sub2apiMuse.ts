const rules = [
  {
    type: "input",
    field: "baseUrl" as const,
    title: "Sub2API 地址",
    value: "https://proxy.thpvip.xyz",
    props: { placeholder: "https://你的 Sub2API 域名，可带 /v1" },
    validate: [{ required: true, message: "请填写 Sub2API 地址", trigger: "blur" }],
  },
  {
    type: "input",
    field: "apiKey" as const,
    title: "Sub2API API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
];

type MuseVideoRequest = VideoRequest & {
  referenceOrder?: ({ type: "image" | "video" | "audio"; index: number } | { type: "firstFrame" | "lastFrame" | "text" })[];
};

type VideoTask = { id?: string; task_id?: string; status?: string; error?: unknown };

function connection(config: { baseUrl: string; apiKey: string }) {
  const apiKey = config.apiKey.trim();
  if (!apiKey) throw new Error("请填写 Sub2API API Key");
  let url: URL;
  try { url = new URL(config.baseUrl.trim()); }
  catch { throw new Error("请填写有效的 Sub2API HTTP/HTTPS 地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Sub2API 地址须为不含凭据、查询参数或片段的 HTTP/HTTPS 地址");
  }
  const baseUrl = url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
  return { baseUrl, apiKey };
}

function requestSignal(signal?: AbortSignal) {
  return AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(signal ? [signal] : [])]);
}

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function referenceImages(images: MediaInput[]) {
  if (images.length > 4) throw new Error("Muse 最多支持 4 张参考图");
  return images.map(mediaUrl);
}

function videoPrompt(request: MuseVideoRequest) {
  return request.prompt.replace(/\{\{ref (\d+)\}\}/g, (marker, number: string) => {
    const reference = request.referenceOrder?.[Number(number) - 1];
    if (reference?.type === "text") return `参考 ${number}`;
    if (reference?.type === "firstFrame" && request.firstFrame) return "图片1";
    if (reference?.type === "image" && request.images?.[reference.index]) {
      return `图片${reference.index + 1 + (request.firstFrame ? 1 : 0)}`;
    }
    throw new Error(`引用标记 ${marker} 缺少有效的图片或文本映射`);
  });
}

async function requestJson(context: ProviderContext, url: string, apiKey: string, signal: AbortSignal, body?: unknown) {
  const response = await context.tool.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`Sub2API 请求失败：HTTP ${response.status}`);
  return response.json();
}

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function downloadVideo(context: ProviderContext, url: string, apiKey: string, signal: AbortSignal): Promise<MediaAsset[]> {
  // Sub2API 的成品路径需要同一把 Key；不能把 URL 交给宿主做匿名下载。
  const response = await context.tool.fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error", signal });
  if (!response.ok) throw new Error(`下载 Muse 视频失败：HTTP ${response.status}`);
  const maxSize = 100 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maxSize) {
    await response.body?.cancel();
    throw new Error("生成视频不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("生成视频为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) throw new Error("生成视频不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  if (!size) throw new Error("生成视频为空");
  return [{ mediaType: "video", type: "binary", data: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") || "application/octet-stream" }];
}

async function pollVideo(context: ProviderContext, baseUrl: string, apiKey: string, taskId: string, signal: AbortSignal): Promise<MediaAsset[]> {
  const taskUrl = `${baseUrl}/v1/videos/${encodeURIComponent(taskId)}`;
  while (true) {
    const data = await requestJson(context, taskUrl, apiKey, signal) as VideoTask;
    const status = data?.status;
    if (status === "completed") return downloadVideo(context, `${taskUrl}/content`, apiKey, signal);
    if (["failed", "cancelled", "canceled", "expired"].includes(status ?? "")) {
      throw Object.assign(new Error(context.tool.errorMessage(data) || "Muse 视频生成失败"), { code: "MEDIA_TASK_FAILED" });
    }
    if (status !== "queued" && status !== "processing") throw new Error("Sub2API 返回了无法识别的视频任务状态");
    await wait(signal);
  }
}

export default {
  id: "sub2apiMuse",
  label: "Sub2API / Muse",
  icon: "",
  version: "1.0.0",
  readme: `填写 Sub2API 的地址和 API Key，即可使用 Muse 图片与视频。

支持文生图、文生视频和最多 4 张参考图。视频按参考图顺序生成，第一张作为主要起始画面。

图片每次生成一张，视频默认请求 6 秒。比例、时长和分辨率由 Muse 按提示词生成，实际成品可能不同；费用以 Sub2API 的定价为准。`,
  rules,
  models: [
    {
      id: "muse-image",
      label: "Muse 图片",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["auto"],
      imageRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    },
    {
      id: "muse-video",
      label: "Muse 视频",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:4"]],
      durationResolutionMap: [{ duration: [6], resolution: ["480p", "720p", "1080p"] }],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const { baseUrl, apiKey } = connection(this.config);
    if (!request.prompt.trim()) throw new Error("请输入生成提示词");
    if (request.mask) throw new Error("Muse 不支持蒙版编辑");
    if (request.n !== undefined && request.n !== 1) throw new Error("Muse 每次仅支持生成一张图片");
    const images = referenceImages(request.images ?? []);
    const data = await requestJson(this, `${baseUrl}/v1/images/generations`, apiKey, requestSignal(this.signal), {
      model: request.model, prompt: request.prompt, n: 1, response_format: "b64_json",
      aspect_ratio: request.ratio, size: request.size,
      ...(images.length ? { images } : {}),
    }) as { data?: { b64_json?: string }[] };
    const image = data?.data?.[0]?.b64_json;
    if (typeof image !== "string" || !image) throw new Error(this.tool.errorMessage(data) || "Sub2API 未返回图片内容");
    return [{ mediaType: "image", type: "base64", data: image, mimeType: "application/octet-stream" }];
  },
  async generateVideo(request: MuseVideoRequest): Promise<MediaAsset[]> {
    const { baseUrl, apiKey } = connection(this.config);
    if (!request.prompt.trim()) throw new Error("请输入生成提示词");
    if (request.lastFrame || request.videos?.length || request.audios?.length) throw new Error("Muse 视频仅支持图片参考，不支持尾帧、视频或音频参考");
    const images = referenceImages([...(request.firstFrame ? [request.firstFrame] : []), ...(request.images ?? [])]);
    const duration = request.duration ?? 6;
    if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("视频时长须为正整数秒");
    const signal = requestSignal(this.signal);
    const data = await requestJson(this, `${baseUrl}/v1/videos`, apiKey, signal, {
      model: request.model, prompt: videoPrompt(request), duration,
      aspect_ratio: request.ratio, resolution: request.resolution,
      ...(images.length ? { images } : {}),
    }) as VideoTask;
    const taskId = data?.id ?? data?.task_id;
    if (typeof taskId !== "string" || !/^muse:[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error("Sub2API 未返回有效的 Muse 视频任务 ID");
    await this.saveTaskData?.({ kind: "video", taskId, baseUrl });
    return pollVideo(this, baseUrl, apiKey, taskId, signal);
  },
  async resumeTask(data: ProviderTaskData): Promise<MediaAsset[]> {
    const { baseUrl, apiKey } = connection(this.config);
    if (data.kind !== "video" || data.baseUrl !== baseUrl || typeof data.taskId !== "string" || !/^muse:[a-zA-Z0-9_-]+$/.test(data.taskId)) {
      throw new Error("视频任务恢复数据无效或 Sub2API 地址已变更");
    }
    return pollVideo(this, baseUrl, apiKey, data.taskId, requestSignal(this.signal));
  },
} satisfies ProviderDefinition<typeof rules>;
