import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useToast } from './ui'

/**
 * 渠道同步刷新：美团同步插件在本页以页面身份写入（建单 / 取消 / 更正姓名）后，
 * 向 window 派发 `pms:ota-sync` 事件；这里让所有查询失效，当前页面立即重拉，
 * 并 toast 一句发生了什么——前台不用手动刷新就能看到新单。AppShell 挂载，无界面。
 */
export default function OtaSyncListener() {
  const qc = useQueryClient()
  const toast = useToast()
  useEffect(() => {
    const onSync = (e: Event) => {
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message
      qc.invalidateQueries()
      if (msg) toast(msg)
    }
    window.addEventListener('pms:ota-sync', onSync)
    return () => window.removeEventListener('pms:ota-sync', onSync)
  }, [qc, toast])
  return null
}
