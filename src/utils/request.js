import axios from 'axios'

/**
 * 全局唯一的 axios 实例。所有请求都必须经由此处，禁止在组件里直接 import axios。
 *
 * 约定：
 * - 业务接口统一返回 { code, data, message }，code === 0 视为成功
 * - 令牌放在 localStorage 的 token 键下，需要调整只改 getToken / clearToken
 */

const TOKEN_KEY = 'token'

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

const request = axios.create({
  // 走相对路径，具体后端地址交给 vite 的 server.proxy 或网关处理
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
})

request.interceptors.request.use(
  (config) => {
    const token = getToken()
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error),
)

request.interceptors.response.use(
  (response) => {
    const body = response.data

    // 二进制流（文件导出等）原样返回，不参与业务码解析
    if (response.config.responseType === 'blob' || response.config.responseType === 'arraybuffer') {
      return body
    }

    // 后端未使用统一包装时，直接把 data 交给调用方
    if (body === null || typeof body !== 'object' || !('code' in body)) {
      return body
    }

    if (body.code === 0) {
      return body.data
    }

    if (body.code === 401) {
      handleUnauthorized()
    }

    return Promise.reject(Object.assign(new Error(body.message || '请求失败'), { code: body.code }))
  },
  (error) => Promise.reject(normalizeError(error)),
)

/** 网络层错误统一成带可读 message 的 Error，避免调用方到处判断 error.response */
function normalizeError(error) {
  let message = '网络异常，请稍后重试'

  if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
    message = '请求超时'
  } else if (error.response) {
    const status = error.response.status
    const map = {
      400: '请求参数有误',
      401: '登录状态已失效',
      403: '没有访问权限',
      404: '接口不存在',
      500: '服务异常',
      502: '网关异常',
      503: '服务暂不可用',
    }
    message = map[status] || `请求失败（${status}）`

    if (status === 401) {
      handleUnauthorized()
    }
  }

  return Object.assign(new Error(message), {
    code: error.response?.status ?? error.code,
    raw: error,
  })
}

/** 401 处理：清令牌 + 跳登录页。用动态 import 打断 store/router 与 request 的循环依赖 */
function handleUnauthorized() {
  clearToken()
  import('@/router').then(({ default: router }) => {
    const current = router.currentRoute.value
    if (current.name !== 'login') {
      router.replace({ name: 'login', query: { redirect: current.fullPath } })
    }
  })
}

export default request
