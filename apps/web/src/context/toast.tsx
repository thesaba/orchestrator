import { createContext, useContext } from 'react'

export interface ToastOptions {
  error?: boolean
}

export type ShowToastFn = (content: string, options?: ToastOptions) => void

export const ToastContext = createContext<ShowToastFn>(() => {})

export function useToast(): ShowToastFn {
  return useContext(ToastContext)
}
