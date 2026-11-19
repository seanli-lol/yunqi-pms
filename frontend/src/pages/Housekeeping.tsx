import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Task } from '../api'
import { Badge, Dialog, Field, PageHead, Spinner, useToast } from '../ui'

const TYPE_LABEL: Record<string, string> = {
  checkout: '退房清洁', daily: '日常清扫', deep: '深度清洁', repair: '维修', inspection: '检查',
}

export default function Housekeeping() {
  const toast = useToast()
  const qc = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)

  const list = useQuery({
    queryKey: ['housekeeping', 'all'],
    queryFn: () => api.get<Task[]>('/api/housekeeping?status=all'),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['housekeeping'] })
    qc.invalidateQueries({ queryKey: ['board'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const mut = useMutation({
    mutationFn: (p: { path: string; label: string }) => api.post(p.path, {}),
    onSuccess: (_d, p) => { toast(p.label); invalidate() },
    onError: (e: any) => toast(e.message ?? '操作失败'),
  })

  const tasks = list.data ?? []
  const cols: { key: string; title: string; color: 'gray' | 'orange' | 'green'; items: Task[]; action?: 'start' | 'complete' }[] = [
    { key: 'pending', title: '待清洁', color: 'gray', items: tasks.filter(t => t.status === 'pending'), action: 'start' },
    { key: 'in_progress', title: '进行中', color: 'orange', items: tasks.filter(t => t.status === 'in_progress'), action: 'complete' },
    { key: 'done', title: '已完成', color: 'green', items: tasks.filter(t => t.status === 'done') },
  ]

  return (
    <>
      <PageHead
        title="客房清洁"
        desc={`今日任务 ${tasks.length} · 待处理 ${cols[0].items.length + cols[1].items.length} · 完成后房态自动转为空净`}
        actions={<button className="btn btn-primary" onClick={() => setAddOpen(true)}>添加任务</button>}
      />

      {list.isLoading ? <Spinner /> : (
        <div className="kanban">
          {cols.map(col => (
            <div className="kan-col" key={col.key}>
              <div className="kan-head">
                <span className="kan-title">{col.title}</span>
                <Badge color={col.color}>{col.items.length}</Badge>
              </div>
              {col.items.map(t => (
                <div className="card task" key={t.id}>
                  <div className="task-top">
                    <span className="task-room">{t.room_number}</span>
                    {t.status === 'done'
                      ? <Badge color="green">完成</Badge>
                      : t.priority === 'high' ? <Badge color="red">高</Badge>
                      : t.priority === 'mid' ? <Badge color="orange">中</Badge>
                      : <Badge color="gray">低</Badge>}
                  </div>
                  <div className="task-type">{TYPE_LABEL[t.task_type]} · {t.room_type_name} · {t.floor}F</div>
                  <div className="task-foot">
                    <span className="task-assignee">
                      <span className="avatar sm">{t.assignee ? t.assignee.charAt(0) : '—'}</span>
                      {t.assignee || '待分配'}
                    </span>
                    <span>
                      {t.status === 'done' && t.completed_at ? `${t.completed_at.slice(11, 16)} 完成` : t.created_at ? `${t.created_at.slice(11, 16)} 生成` : ''}
                    </span>
                  </div>
                  {col.action && (
                    <div className="task-actions">
                      {col.action === 'start'
                        ? <button className="btn btn-ghost btn-sm" onClick={() => mut.mutate({ path: `/api/housekeeping/${t.id}/start`, label: `${t.room_number} 清洁已开始` })}>开始</button>
                        : <button className="btn btn-primary btn-sm" onClick={() => mut.mutate({ path: `/api/housekeeping/${t.id}/complete`, label: `${t.room_number} 清洁完成，房态转为空净` })}>完成</button>}
                    </div>
                  )}
                </div>
              ))}
              {col.items.length === 0 && <div className="empty">暂无任务</div>}
            </div>
          ))}
        </div>
      )}

      <AddTaskDialog
        open={addOpen} onClose={() => setAddOpen(false)}
      />
    </>
  )
}

function AddTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [roomId, setRoomId] = useState<number | null>(null)
  const [type, setType] = useState('daily')
  const [priority, setPriority] = useState('mid')
  const [assignee, setAssignee] = useState('')
  const [notes, setNotes] = useState('')

  const rooms = useQuery({ queryKey: ['rooms'], queryFn: () => api.get<any[]>('/api/rooms') })
  const mut = useMutation({
    mutationFn: (body: any) => api.post('/api/housekeeping', body),
    onSuccess: () => {
      toast('清洁任务已创建并派发')
      qc.invalidateQueries({ queryKey: ['housekeeping'] })
      qc.invalidateQueries({ queryKey: ['rooms'] })
      qc.invalidateQueries({ queryKey: ['board'] })
      onClose()
    },
    onError: (e: any) => toast(e.message ?? '创建失败'),
  })

  return (
    <Dialog
      open={open} onClose={onClose} title="添加清洁任务"
      foot={
        <>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-primary" disabled={!roomId}
            onClick={() => mut.mutate({ room_id: roomId, task_type: type, priority, assignee, notes })}
          >创建任务</button>
        </>
      }
    >
      <div className="form-row">
        <Field label="房间" required>
          <select className="select" value={roomId ?? ''} onChange={e => setRoomId(Number(e.target.value))}>
            <option value="">请选择房间</option>
            {(rooms.data ?? []).map(r => (
              <option key={r.id} value={r.id}>{r.room_number} · {r.room_type_name} · {r.floor}F</option>
            ))}
          </select>
        </Field>
        <Field label="类型">
          <select className="select" value={type} onChange={e => setType(e.target.value)}>
            <option value="daily">日常清扫</option><option value="checkout">退房清洁</option>
            <option value="deep">深度清洁</option><option value="inspection">检查</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="优先级">
          <select className="select" value={priority} onChange={e => setPriority(e.target.value)}>
            <option value="high">高</option><option value="mid">中</option><option value="low">低</option>
          </select>
        </Field>
        <Field label="负责人">
          <input className="input" value={assignee} onChange={e => setAssignee(e.target.value)} placeholder="如：张桂芳" />
        </Field>
      </div>
      <Field label="备注"><input className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="如：客人 18:00 抵店，需优先完成" /></Field>
    </Dialog>
  )
}
