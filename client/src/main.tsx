import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'

import { App } from './App.js'
import './styles/global.css'

/**
 * Defaults chosen for a calendar several people change at once
 * (docs/02-architecture.md section 8). Per-query overrides tighten these:
 * availability refetches on an interval, while rooms and users rarely change.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      // A 409 or 403 will not succeed on retry; only retry what might.
      retry: (failureCount, error) => {
        const status = (error as { status?: number }).status
        if (status !== undefined && status < 500) return false
        return failureCount < 2
      },
    },
    mutations: { retry: false },
  },
})

const container = document.getElementById('root')
if (!container) throw new Error('Root element #root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
