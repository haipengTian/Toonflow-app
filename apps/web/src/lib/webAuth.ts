import { ref } from "vue";
import axios from "axios";

export const webAuthEnabled = ref(false);

export async function initializeWebAuth() {
  const response = await fetch("/api/auth/session", { cache: "no-store" });
  if (!response.ok) throw new Error("无法检查登录状态，请刷新重试");
  const result = await response.json();
  webAuthEnabled.value = result.data?.enabled === true;
  if (!webAuthEnabled.value) return;
  if (!result.data.authenticated) {
    window.location.replace("/login");
    await new Promise<void>(() => {});
  }
  axios.interceptors.response.use(response => response, error => {
    const url = new URL(error.config?.url ?? "/", window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/") && error.response?.status === 401 && error.response?.headers?.["x-toonflow-auth"] === "required") {
      window.location.assign("/login");
    }
    return Promise.reject(error);
  });
  // 原生 fetch、媒体和流式请求也会在服务端失效；定期检查将页面带回登录入口。
  let checking = false;
  async function refreshSession() {
    if (checking) return;
    checking = true;
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" });
      if (response.ok && !(await response.json()).data?.authenticated) window.location.assign("/login");
    } catch { /* 网络暂不可用时保留当前画布。 */ }
    finally { checking = false; }
  }
  window.setInterval(refreshSession, 60000);
  window.addEventListener("focus", refreshSession);
}
