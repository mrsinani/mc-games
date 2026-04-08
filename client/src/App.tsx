import { useState } from 'react'
import { useApp } from './context/AppContext'
import { Header } from './components/Header'
import { TabBar, type Tab } from './components/TabBar'
import { GamesTab } from './components/GamesTab'
import { ProfileTab } from './components/ProfileTab'
import { DevTab } from './components/DevTab'
import { TelegramLogin } from './components/TelegramLogin'
import { PlinkoGame } from './components/PlinkoGame'
import { RocketGame } from './components/RocketGame'

function AppContent() {
  const { loading, error, needsLogin, loginWithWidgetData } = useApp()
  const [activeTab, setActiveTab] = useState<Tab>('games')
  const [activeGame, setActiveGame] = useState<string | null>(null)

  if (loading) {
    return (
      <div className="min-h-dvh bg-black flex items-center justify-center">
        <p className="text-white text-lg">Loading...</p>
      </div>
    )
  }

  if (needsLogin) {
    return <TelegramLogin onLogin={loginWithWidgetData} />
  }

  if (error) {
    return (
      <div className="min-h-dvh bg-black flex items-center justify-center px-6">
        <p className="text-neutral-400 text-center">{error}</p>
      </div>
    )
  }

  if (activeGame === 'plinko') {
    return <PlinkoGame onBack={() => setActiveGame(null)} />
  }

  if (activeGame === 'rocket') {
    return <RocketGame onBack={() => setActiveGame(null)} />
  }

  return (
    <div className="min-h-dvh bg-black flex flex-col">
      <Header />
      <main className="flex-1 overflow-y-auto pt-14 pb-20">
        {activeTab === 'games' && <GamesTab onGameSelect={setActiveGame} />}
        {activeTab === 'profile' && <ProfileTab />}
        {activeTab === 'dev' && <DevTab />}
      </main>
      <TabBar active={activeTab} onChange={setActiveTab} />
    </div>
  )
}

export default function App() {
  return <AppContent />
}
