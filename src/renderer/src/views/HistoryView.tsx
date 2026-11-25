import { Download, History, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { EntryStatus, HistoryFilter, HistoryResult } from '@shared/types'
import { TopBar } from '../components/ui'
import { useStore } from '../store'
import { EntryCard } from './SessionView'

const STATUSES: (EntryStatus | '')[] = ['', 'done', 'failed', 'denied', 'stopped', 'timeout']

/**
 * Every finished command from the history files, searchable by text, node,
 * who ran it and how it ended, and exportable as Markdown or JSONL.
 */
export function HistoryView() {
  const platform = useStore((s) => s.platform)
  const [filter, setFilter] = useState<HistoryFilter>({ text: '', node: '', by: '', status: '', days: 7 })
  const [result, setResult] = useState<HistoryResult | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  // Typing searches after a short pause, not on every key.
  useEffect(() => {
    const t = setTimeout(() => void window.tsheep.history.search(filter).then(setResult), 250)
    return () => clearTimeout(t)
  }, [filter])

  const set = (patch: Partial<HistoryFilter>) => setFilter((f) => ({ ...f, ...patch }))
  const save = (kind: 'md' | 'jsonl') =>
    void window.tsheep.history.export(filter, kind).then((r) => setSaved(r ? `${r.count} commands saved to ${r.path}` : null))

  return (
    <>
      <TopBar title="History" platform={platform}>
        <button type="button" className="btn sm" onClick={() => save('md')} disabled={!result?.hits.length}>
          <Download size={13} /> Markdown
        </button>
        <button type="button" className="btn sm" onClick={() => save('jsonl')} disabled={!result?.hits.length}>
          <Download size={13} /> JSONL
        </button>
      </TopBar>
      <div className="main-scroll">
        <div className="content">
          <div className="history-filters">
            <label className="history-search">
              <Search size={14} />
              <input className="input" placeholder="Text in description, command, output or reason" value={filter.text} onChange={(e) => set({ text: e.target.value })} autoFocus />
            </label>
            <input className="input" placeholder="Node" value={filter.node} onChange={(e) => set({ node: e.target.value })} />
            <input className="input" placeholder="Run by" value={filter.by} onChange={(e) => set({ by: e.target.value })} />
            <select className="select" value={filter.status} onChange={(e) => set({ status: e.target.value as EntryStatus | '' })}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s || 'any status'}
                </option>
              ))}
            </select>
            <select className="select" value={filter.days} onChange={(e) => set({ days: Number(e.target.value) })}>
              <option value={1}>today</option>
              <option value={7}>last 7 days</option>
              <option value={30}>last 30 days</option>
              <option value={0}>everything kept</option>
            </select>
          </div>
          <div className="muted small" style={{ margin: '10px 0 14px' }}>
            {result ? `${result.total} command${result.total === 1 ? '' : 's'} in ${result.days} day file${result.days === 1 ? '' : 's'}${result.total > result.hits.length ? `, newest ${result.hits.length} shown and exported` : ''}` : 'Searching…'}
            {saved ? ` · ${saved}` : ''}
          </div>
          {result && result.hits.length === 0 ? (
            <div className="empty card">
              <History size={20} />
              <h3>Nothing found</h3>
              <div>Only finished commands are kept, one file per day in the data folder.</div>
            </div>
          ) : (
            <div className="timeline">
              {result?.hits.map((h) => (
                <EntryCard key={h.entry.id} entry={h.entry} latest={false} where={h.target || h.installation} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
