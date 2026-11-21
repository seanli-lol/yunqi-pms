import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Guest } from './api'

/**
 * 预订弹层的客人姓名输入：按姓名/手机号联想本店已有客户（GET /api/guests?q=），
 * 下拉展示手机号与备注，选中由父级带出姓名+手机号——后端 upsert_guest 按手机号
 * 复用档案，选中即与老档案联动。
 */
export function GuestNameInput({ value, onChange, onPick, placeholder }: {
  value: string
  onChange: (v: string) => void
  onPick: (g: Guest) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const kw = value.trim()

  const search = useQuery({
    queryKey: ['guest-search', kw],
    enabled: open && kw.length >= 1,
    queryFn: () => api.get<Guest[]>(`/api/guests?q=${encodeURIComponent(kw)}`),
  })

  // 点击组件外部关闭下拉
  useEffect(() => {
    if (!open) return
    const onDoc = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDoc)
    return () => document.removeEventListener('pointerdown', onDoc)
  }, [open])

  const matches = (search.data ?? []).slice(0, 8)

  return (
    <div className="ga-wrap" ref={wrapRef}>
      <input
        className="input"
        value={value}
        placeholder={placeholder ?? '请输入姓名'}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => { if (kw.length >= 1) setOpen(true) }}
      />
      {open && kw.length >= 1 && (
        <div className="ga-pop">
          {matches.length === 0 ? (
            <div className="ga-empty">{search.isLoading ? '搜索中…' : '无匹配客户，将新建档案'}</div>
          ) : matches.map(g => (
            <button type="button" className="ga-item" key={g.id}
                    onMouseDown={() => { onPick(g); setOpen(false) }}>
              <span className="ga-name">{g.name}</span>
              <span className="ga-phone">{g.phone || '无手机号'}</span>
              {g.notes && <span className="ga-notes" title={g.notes}>{g.notes}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
