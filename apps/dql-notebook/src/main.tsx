import React from 'react'
import { createRoot } from 'react-dom/client'
import '@duckcodeailabs/dql-ui/styles'
import { App } from './App'
// Self-installs when ?embedded=1 — namespaces localStorage by project,
// applies theme tokens posted from the parent frame, and intercepts
// fetch() to add the tenant bearer token. No-op for standalone use.
import './embedded'

createRoot(document.getElementById('root')!).render(<App />)
