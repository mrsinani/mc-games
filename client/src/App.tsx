import { useState } from 'react'
import { useApp } from './context/AppContext'
import { Header } from './components/Header'
import { TabBar, type Tab } from './components/TabBar'
import { HomeTab } from './components/HomeTab'
import { TelegramLogin } from './components/TelegramLogin'
import { PlinkoGame } from './components/PlinkoGame'
import { RocketGame } from './components/RocketGame'

function AppContent() {
  const { loading, error, needsLogin, loginWithWidgetData, loginAsDev, config } = useApp()
  const [activeTab, setActiveTab] = useState<Tab>('home')

  const enabledGames = {
    plinko: Boolean(config?.plinko_enabled),
    rocket: Boolean(config?.rocket_enabled),
    pvp: Boolean(config?.pvp_enabled),
  }

  if (loading) {
    return (
      <div className="h-dvh bg-black flex items-center justify-center">
        <p className="text-white text-lg">Loading...</p>
      </div>
    )
  }

  if (needsLogin) {
    return <TelegramLogin onLogin={loginWithWidgetData} onDevLogin={loginAsDev} />
  }

  if (error) {
    return (
      <div className="h-dvh bg-black flex items-center justify-center px-6">
        <p className="text-neutral-400 text-center">{error}</p>
      </div>
    )
  }

  function handleTabChange(tab: Tab) {
    if (tab === 'plinko' && !enabledGames.plinko) return
    if (tab === 'rocket' && !enabledGames.rocket) return
    if (tab === 'pvp' && !enabledGames.pvp) return
    setActiveTab(tab)
  }

  return (
    <div className="h-dvh bg-black flex flex-col overflow-hidden">
      <Header />
      <main className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'home' && <HomeTab onNavigate={handleTabChange} />}
        {activeTab === 'plinko' && <PlinkoGame />}
        {activeTab === 'rocket' && <RocketGame />}
      </main>
      <TabBar active={activeTab} onChange={handleTabChange} enabledGames={enabledGames} />
    </div>
  )
}

export default function App() {
  return <AppContent />
}
