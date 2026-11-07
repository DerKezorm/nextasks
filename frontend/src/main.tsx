import './fakeFirst'
import '@fontsource-variable/inter'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import App from './App'
import './i18n'
import { startApp } from './lib/pwa'
import { followSystem } from './lib/theme'
import { bearTranslatedPages } from './lib/translatedPage'
import { AuthProvider } from './state/auth'
import './styles/index.css'

followSystem()
startApp()
bearTranslatedPages()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
