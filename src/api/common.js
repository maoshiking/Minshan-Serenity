import request from '@/utils/request'

/**
 * 接口层：只负责拼参数、发请求，不做任何界面逻辑。
 * 后端未就绪前，这些函数会在开发环境返回 404，属预期现象。
 */

/** 健康检查，可用它验证 request.js 链路是否通 */
export function fetchHealth() {
  return request.get('/health')
}

/** 示例：分页列表 */
export function fetchItems(params = {}) {
  const { page = 1, pageSize = 20, keyword = '' } = params
  return request.get('/items', { params: { page, pageSize, keyword } })
}

/** 示例：详情 */
export function fetchItemDetail(id) {
  return request.get(`/items/${id}`)
}
