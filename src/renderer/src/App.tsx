import { useEffect } from 'react'
import { Sidebar } from './components/Sidebar'
import { useStore } from './store'
import { ConnectView } from './views/ConnectView'
import { HistoryView } from './views/HistoryView'
import { InstallationsView } from './views/InstallationsView'
import { NodesView } from './views/NodesView'
import { SessionView } from './views/SessionView'
import { SettingsView } from './views/SettingsView'

export default function App() {
  const ready = useStore((s) => s.ready)
  const boot = useStore((s) => s.boot)
  const view = useStore((s) => s.view)

  useEffect(() => {
    void boot()
  }, [boot])

  if (!ready) return <div className="app" />

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view.kind === 'session' ? <SessionView id={view.id} /> : null}
        {view.kind === 'nodes' ? <NodesView /> : null}
        {view.kind === 'history' ? <HistoryView /> : null}
        {view.kind === 'installations' ? <InstallationsView /> : null}
        {view.kind === 'connect' ? <ConnectView /> : null}
        {view.kind === 'settings' ? <SettingsView /> : null}
      </main>
    </div>
  )
}
