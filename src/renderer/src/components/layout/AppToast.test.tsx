// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppToast } from './AppToast'

afterEach(cleanup)

describe('AppToast', () => {
  it('renders ordinary feedback as a compact polite status', () => {
    const onClose = vi.fn()
    render(<AppToast message={{ kind: 'ok', text: '检测完成' }} onClose={onClose} />)

    const toast = screen.getByRole('status')
    expect(toast).toHaveClass('app-toast', 'app-toast--ok')
    expect(toast).toHaveAttribute('aria-live', 'polite')
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('announces errors immediately without reusing legacy message styles', () => {
    render(<AppToast message={{ kind: 'error', text: '上游不可用' }} onClose={vi.fn()} />)

    const toast = screen.getByRole('alert')
    expect(toast).toHaveClass('app-toast--error')
    expect(toast).toHaveAttribute('aria-live', 'assertive')
    expect(toast).not.toHaveClass('message')
  })
})
