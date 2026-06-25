import React, { useState, useEffect, useCallback, useRef, KeyboardEvent } from 'react'
import { Button, InlineStack, Text, Badge, Spinner, Modal, TextField, Banner, Checkbox } from '@shopify/polaris'
import Editor, { OnMount } from '@monaco-editor/react'
import { fmApi, FMEntry } from '../api/client'
import pathBrowserify from 'path-browserify'

// ── Helpers ────────────────────────────────────────────────────────────────────
function fmtSize(bytes: number): string {
  if (bytes === 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  })
}

function fileIcon(entry: FMEntry): string {
  if (entry.type === 'dir') return '📁'
  if (entry.type === 'symlink') return '🔗'
  const icons: Record<string, string> = {
    php: '🐘', js: '📜', ts: '📘', tsx: '📘', jsx: '📜',
    html: '🌐', css: '🎨', json: '📋', md: '📝', txt: '📄',
    env: '🔒', sh: '⚙️', sql: '🗄️', xml: '📋', yaml: '⚙️', yml: '⚙️',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    pdf: '📕', mp4: '🎬', webm: '🎬', mov: '🎬',
    zip: '📦', tar: '📦', gz: '📦',
    log: '📋', conf: '⚙️', ini: '⚙️',
  }
  return icons[entry.ext] ?? '📄'
}

function extToMonacoLang(ext: string): string {
  const map: Record<string, string> = {
    php: 'php', js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
    html: 'html', css: 'css', json: 'json', md: 'markdown', txt: 'plaintext',
    env: 'plaintext', sh: 'shell', sql: 'sql', xml: 'xml', yaml: 'yaml', yml: 'yaml',
    conf: 'nginx', ini: 'ini', log: 'plaintext', py: 'python',
  }
  return map[ext] ?? 'plaintext'
}

function joinPath(...parts: string[]): string {
  const joined = parts.join('/').replace(/\/+/g, '/')
  return joined || '/'
}

const BOOKMARKS = [
  { label: 'Site Root', icon: '🏠', path: '/' },
  { label: 'Current',   icon: '🔗', path: '/current' },
  { label: 'Shared',    icon: '📁', path: '/shared' },
  { label: 'Logs',      icon: '📋', path: '/shared/logs' },
  { label: 'Releases',  icon: '📦', path: '/releases' },
]

// ── Context Menu ───────────────────────────────────────────────────────────────
interface CtxItem {
  label?: string
  icon?: string
  shortcut?: string
  separator?: boolean
  action?: () => void
  disabled?: boolean
  danger?: boolean
}

function ContextMenu({ items, x, y, onClose }: {
  items: CtxItem[]
  x: number
  y: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])

  const style: React.CSSProperties = {
    position: 'fixed', top: y, left: x, zIndex: 9000,
    background: 'var(--p-color-bg-surface)',
    border: '1px solid var(--oc-border)',
    borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    minWidth: 200, padding: '4px 0', userSelect: 'none'
  }

  return (
    <div ref={ref} style={style} onContextMenu={e => e.preventDefault()}>
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={i} style={{ height: 1, background: 'var(--oc-border)', margin: '4px 0' }} />
        }
        return (
          <div
            key={i}
            onClick={() => { if (!item.disabled) { item.action?.(); onClose() } }}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 14px', cursor: item.disabled ? 'not-allowed' : 'pointer',
              fontSize: 13,
              color: item.danger
                ? 'var(--oc-remove-color)'
                : item.disabled
                  ? 'var(--oc-text-subdued)'
                  : 'var(--p-color-text)',
              justifyContent: 'space-between'
            }}
            onMouseEnter={e => {
              if (!item.disabled) (e.currentTarget as HTMLDivElement).style.background = 'var(--oc-bg-secondary)'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLDivElement).style.background = ''
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {item.icon && <span style={{ width: 16, textAlign: 'center' }}>{item.icon}</span>}
              {item.label}
            </span>
            {item.shortcut && (
              <span style={{ fontSize: 11, color: 'var(--oc-text-subdued)' }}>{item.shortcut}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── File Pane ──────────────────────────────────────────────────────────────────
interface PaneProps {
  siteId: number
  currentPath: string
  selected: Set<string>
  onNavigate: (p: string) => void
  onSelect: (name: string, multi: boolean, range: boolean) => void
  onOpen: (entry: FMEntry) => void
  onContextMenu: (e: React.MouseEvent, entry: FMEntry | null) => void
  entries: FMEntry[]
  loading: boolean
  sort: string
  sortDir: 'asc' | 'desc'
  onSort: (col: string) => void
  onDrop: (files: File[]) => void
}

function FilePane({
  currentPath, selected, onNavigate, onSelect, onOpen, onContextMenu,
  entries, loading, sort, sortDir, onSort, onDrop
}: PaneProps) {
  const [dragOver, setDragOver] = useState(false)

  const col = (label: string, key: string, flex: string | number = 1) => (
    <div
      onClick={() => onSort(key)}
      style={{
        flex, padding: '6px 8px', fontWeight: 600, fontSize: 11,
        color: 'var(--oc-text-subdued)', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 4,
        borderBottom: '1px solid var(--oc-border)',
        userSelect: 'none', background: 'var(--oc-bg-secondary)'
      }}
    >
      {label}
      {sort === key && <span>{sortDir === 'asc' ? '↑' : '↓'}</span>}
    </div>
  )

  return (
    <div
      style={{
        flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column',
        border: '1px solid var(--oc-border)', borderRadius: 8, position: 'relative',
        background: dragOver ? 'rgba(69,143,255,0.05)' : undefined
      }}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault(); setDragOver(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length > 0) onDrop(files)
      }}
      onContextMenu={e => { e.preventDefault(); onContextMenu(e, null) }}
    >
      {/* Column headers */}
      <div style={{ display: 'flex', flexShrink: 0 }}>
        {col('Name', 'name', 3)}
        {col('Size', 'size', 1)}
        {col('Modified', 'modified', 2)}
        {col('Perms', 'perms', 1)}
      </div>

      {/* Entries */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Spinner size="small" />
          </div>
        ) : (
          <>
            {/* Parent directory */}
            {currentPath !== '/' && (
              <div
                onDoubleClick={() => onNavigate(pathBrowserify.dirname(currentPath) || '/')}
                style={{
                  display: 'flex', alignItems: 'center', padding: '5px 8px',
                  gap: 6, fontSize: 13, cursor: 'pointer',
                  borderBottom: '1px solid var(--oc-border)'
                }}
                onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.background = 'var(--oc-bg-secondary)')}
                onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.background = '')}
              >
                <span>📁</span>
                <span style={{ color: 'var(--oc-text-subdued)' }}>..</span>
              </div>
            )}

            {entries.map((entry) => {
              const sel = selected.has(entry.name)
              return (
                <div
                  key={entry.name}
                  style={{
                    display: 'flex', alignItems: 'center',
                    background: sel ? 'rgba(69,143,255,0.15)' : undefined,
                    borderBottom: '1px solid var(--oc-border)',
                    cursor: 'pointer', userSelect: 'none'
                  }}
                  onClick={(e) => onSelect(entry.name, e.ctrlKey || e.metaKey, e.shiftKey)}
                  onDoubleClick={() => onOpen(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onContextMenu(e, entry)
                  }}
                  onMouseEnter={e => {
                    if (!sel) (e.currentTarget as HTMLDivElement).style.background = 'var(--oc-bg-secondary)'
                  }}
                  onMouseLeave={e => {
                    if (!sel) (e.currentTarget as HTMLDivElement).style.background = ''
                  }}
                >
                  <div style={{ flex: 3, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', minWidth: 0 }}>
                    <span style={{ flexShrink: 0 }}>{fileIcon(entry)}</span>
                    <span style={{
                      fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontWeight: entry.type === 'dir' ? 600 : 400,
                      color: entry.name.startsWith('.') ? 'var(--oc-text-subdued)' : undefined
                    }}>{entry.name}</span>
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--oc-text-subdued)', padding: '5px 8px' }}>
                    {entry.type === 'dir' ? '—' : fmtSize(entry.size)}
                  </div>
                  <div style={{ flex: 2, fontSize: 11, color: 'var(--oc-text-subdued)', padding: '5px 8px' }}>
                    {fmtDate(entry.modified)}
                  </div>
                  <div style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: 'var(--oc-text-subdued)', padding: '5px 8px' }}>
                    {entry.permsDisplay}
                  </div>
                </div>
              )
            })}

            {entries.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--oc-text-subdued)', fontSize: 13 }}>
                Empty directory
              </div>
            )}
          </>
        )}
      </div>

      {/* Drop overlay hint */}
      {dragOver && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(69,143,255,0.1)', border: '2px dashed #458fff', borderRadius: 8,
          pointerEvents: 'none', fontSize: 16, fontWeight: 600, color: '#458fff'
        }}>
          Drop files to upload
        </div>
      )}
    </div>
  )
}

// ── Preview Modal ──────────────────────────────────────────────────────────────
function PreviewModal({ siteId, entry, onClose }: {
  siteId: number
  entry: FMEntry & { name: string }
  onClose: () => void
}) {
  const isImage = entry.mime.startsWith('image/')
  const isVideo = entry.mime.startsWith('video/')
  const isPdf = entry.mime === 'application/pdf'
  const isText = entry.mime.startsWith('text/') || entry.mime === 'application/json'

  return (
    <Modal open title={`Preview: ${pathBrowserify.basename(entry.name)}`} onClose={onClose} size="large">
      <Modal.Section>
        {isImage && (
          <div style={{ textAlign: 'center' }}>
            <img
              src={fmApi.downloadUrl(siteId, entry.name)}
              alt={pathBrowserify.basename(entry.name)}
              style={{ maxWidth: '100%', maxHeight: 600, objectFit: 'contain' }}
            />
          </div>
        )}
        {isVideo && (
          <video controls style={{ width: '100%', maxHeight: 500 }}>
            <source src={fmApi.downloadUrl(siteId, entry.name)} type={entry.mime} />
          </video>
        )}
        {isPdf && (
          <iframe
            src={fmApi.downloadUrl(siteId, entry.name)}
            style={{ width: '100%', height: 600, border: 'none' }}
            title={pathBrowserify.basename(entry.name)}
          />
        )}
        {isText && (
          <pre className="oc-terminal" style={{ maxHeight: 500, fontSize: 12 }}>
            Loading preview…
          </pre>
        )}
        {!isImage && !isVideo && !isPdf && !isText && (
          <Text as="p" tone="subdued">Preview not available for this file type.</Text>
        )}
      </Modal.Section>
    </Modal>
  )
}

// ── Main FileManagerTab ────────────────────────────────────────────────────────
interface Props {
  siteId: number
  rootPath: string
}

interface Clipboard {
  op: 'copy' | 'cut'
  paths: string[]
}

export function FileManagerTab({ siteId }: Props) {
  // ── State ────────────────────────────────────────────────────────────────────
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<FMEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastSelected, setLastSelected] = useState<string | null>(null)
  const [sort, setSort] = useState('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [showHidden, setShowHidden] = useState(false)
  const [dual, setDual] = useState(false)
  const [rightPath, setRightPath] = useState('/')
  const [rightEntries, setRightEntries] = useState<FMEntry[]>([])
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set())
  const [rightLoading, setRightLoading] = useState(false)
  const [activePane, setActivePane] = useState<'left' | 'right'>('left')

  // Editor state
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorPath, setEditorPath] = useState('')
  const [editorContent, setEditorContent] = useState('')
  const [editorLang, setEditorLang] = useState('plaintext')
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [editorDirty, setEditorDirty] = useState(false)

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; entry: FMEntry | null } | null>(null)

  // Modals
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameFrom, setRenameFrom] = useState('')
  const [renameTo, setRenameTo] = useState('')
  const [newNameOpen, setNewNameOpen] = useState(false)
  const [newNameValue, setNewNameValue] = useState('')
  const [newNameIsDir, setNewNameIsDir] = useState(false)
  const [chmodOpen, setChmodOpen] = useState(false)
  const [chmodMode, setChmodMode] = useState('644')
  const [chmodRecursive, setChmodRecursive] = useState(false)
  const [chownOpen, setChownOpen] = useState(false)
  const [chownOwner, setChownOwner] = useState('www-data')
  const [chownGroup, setChownGroup] = useState('www-data')
  const [chownRecursive, setChownRecursive] = useState(false)
  const [propsOpen, setPropsOpen] = useState(false)
  const [propsEntry, setPropsEntry] = useState<(FMEntry & { totalSize: number }) | null>(null)
  const [previewEntry, setPreviewEntry] = useState<(FMEntry & { name: string }) | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ path: string; name: string }[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [zipNameOpen, setZipNameOpen] = useState(false)
  const [zipNameValue, setZipNameValue] = useState('archive.zip')
  const [archiveFormat, setArchiveFormat] = useState<'zip' | 'tar'>('zip')
  const [opResult, setOpResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)

  const [clipboard, setClipboard] = useState<Clipboard | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async (p: string, pane: 'left' | 'right' = 'left') => {
    if (pane === 'left') setLoading(true)
    else setRightLoading(true)
    try {
      const res = await fmApi.list(siteId, p, { hidden: showHidden, sort, order: sortDir })
      if (pane === 'left') { setEntries(res.entries); setCurrentPath(res.path) }
      else { setRightEntries(res.entries); setRightPath(res.path) }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Load failed'
      setOpResult({ ok: false, msg })
    } finally {
      if (pane === 'left') setLoading(false)
      else setRightLoading(false)
    }
  }, [siteId, showHidden, sort, sortDir])

  useEffect(() => { load(currentPath, 'left') }, [currentPath, sort, sortDir, showHidden]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (dual) load(rightPath, 'right') }, [dual, rightPath, sort, sortDir, showHidden]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection ─────────────────────────────────────────────────────────────
  const handleSelect = useCallback((name: string, multi: boolean, range: boolean, pane: 'left' | 'right' = 'left') => {
    setActivePane(pane)
    const sel = pane === 'left' ? selected : rightSelected
    const setSel = pane === 'left' ? setSelected : setRightSelected
    const ents = pane === 'left' ? entries : rightEntries

    if (range && lastSelected) {
      const names = ents.map(e => e.name)
      const a = names.indexOf(lastSelected)
      const b = names.indexOf(name)
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)]
      setSel(new Set(names.slice(lo, hi + 1)))
    } else if (multi) {
      const next = new Set(sel)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      setSel(next)
    } else {
      setSel(new Set([name]))
    }
    setLastSelected(name)
  }, [selected, rightSelected, entries, rightEntries, lastSelected])

  // ── Open (double click) ───────────────────────────────────────────────────
  const handleOpen = useCallback(async (entry: FMEntry, pane: 'left' | 'right' = 'left') => {
    const base = pane === 'left' ? currentPath : rightPath
    if (entry.type === 'dir') {
      const newPath = joinPath(base === '/' ? '' : base, entry.name)
      if (pane === 'left') setCurrentPath(newPath)
      else setRightPath(newPath)
      return
    }
    if (entry.size > 10 * 1024 * 1024) {
      setOpResult({ ok: false, msg: 'File too large for inline editing (>10MB). Use download instead.' })
      return
    }
    const mime = entry.mime
    const isPreviewable = mime.startsWith('image/') || mime.startsWith('video/') || mime === 'application/pdf'
    if (isPreviewable) {
      const filePath = joinPath(base === '/' ? '' : base, entry.name)
      setPreviewEntry({ ...entry, name: filePath })
      return
    }
    try {
      const filePath = joinPath(base === '/' ? '' : base, entry.name)
      const res = await fmApi.read(siteId, filePath)
      setEditorPath(filePath)
      setEditorContent(res.content)
      setEditorLang(extToMonacoLang(res.ext))
      setEditorDirty(false)
      setEditorError(null)
      setEditorOpen(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Read failed'
      setOpResult({ ok: false, msg })
    }
  }, [siteId, currentPath, rightPath])

  // ── Sort ──────────────────────────────────────────────────────────────────
  const handleSort = (col: string) => {
    if (sort === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSort(col); setSortDir('asc') }
  }

  // ── Save editor ───────────────────────────────────────────────────────────
  const handleEditorSave = useCallback(async () => {
    setEditorSaving(true); setEditorError(null)
    try {
      await fmApi.write(siteId, editorPath, editorContent)
      setEditorDirty(false)
      setOpResult({ ok: true, msg: `Saved: ${editorPath}` })
      await load(currentPath, 'left')
    } catch (e: unknown) {
      setEditorError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setEditorSaving(false)
    }
  }, [siteId, editorPath, editorContent, currentPath, load])

  // ── Context menu builder ──────────────────────────────────────────────────
  const contextMenuItems = useCallback((entry: FMEntry | null): CtxItem[] => {
    const pane = activePane
    const base = pane === 'left' ? currentPath : rightPath
    const sel = pane === 'left' ? selected : rightSelected
    const selPaths = Array.from(sel).map(n => joinPath(base === '/' ? '' : base, n))
    const entryPath = entry ? joinPath(base === '/' ? '' : base, entry.name) : null
    const targetPaths = entryPath && !sel.has(entry!.name) ? [entryPath] : selPaths

    const items: CtxItem[] = []

    if (entry) {
      if (entry.type === 'dir') {
        items.push({ label: 'Open', icon: '📂', action: () => handleOpen(entry, pane) })
      } else {
        items.push({ label: 'Edit', icon: '✏️', action: () => handleOpen(entry, pane) })
        items.push({
          label: 'Quick Preview', icon: '👁️', action: () => {
            setPreviewEntry({ ...entry, name: joinPath(base === '/' ? '' : base, entry.name) })
          }
        })
      }
      items.push({ separator: true })
    }

    items.push({ label: 'Cut', icon: '✂️', shortcut: '⌘X', action: () => setClipboard({ op: 'cut', paths: targetPaths }) })
    items.push({ label: 'Copy', icon: '📋', shortcut: '⌘C', action: () => setClipboard({ op: 'copy', paths: targetPaths }) })
    items.push({
      label: 'Paste', icon: '📌', shortcut: '⌘V', disabled: !clipboard,
      action: async () => {
        if (!clipboard) return
        const dest = base
        if (clipboard.op === 'copy') await fmApi.copy(siteId, clipboard.paths, dest)
        else { await fmApi.move(siteId, clipboard.paths, dest); setClipboard(null) }
        await load(currentPath, 'left')
        if (dual) await load(rightPath, 'right')
      }
    })
    items.push({ separator: true })

    if (entry) {
      items.push({
        label: 'Rename', icon: '✏️', shortcut: 'F2',
        action: () => {
          setRenameFrom(entryPath!)
          setRenameTo(entry.name)
          setRenameOpen(true)
        }
      })
    }

    items.push({
      label: `Delete (${targetPaths.length})`, icon: '🗑️', shortcut: '⌫', danger: true,
      disabled: targetPaths.length === 0,
      action: async () => {
        if (!confirm(`Delete ${targetPaths.length} item(s)?`)) return
        await fmApi.delete(siteId, targetPaths)
        if (pane === 'left') setSelected(new Set())
        else setRightSelected(new Set())
        await load(currentPath, 'left')
        if (dual) await load(rightPath, 'right')
      }
    })

    items.push({ separator: true })

    if (targetPaths.length > 0) {
      items.push({
        label: 'Compress → ZIP', icon: '📦',
        action: () => { setZipNameValue('archive.zip'); setArchiveFormat('zip'); setZipNameOpen(true) }
      })
      items.push({
        label: 'Compress → TAR.GZ', icon: '📦',
        action: () => { setZipNameValue('archive.tar.gz'); setArchiveFormat('tar'); setZipNameOpen(true) }
      })
    }

    if (entry && entry.ext === 'zip') {
      items.push({
        label: 'Extract here', icon: '📤',
        action: async () => {
          const res = await fmApi.unzip(siteId, entryPath!, base)
          setOpResult({ ok: res.ok, msg: res.ok ? 'Extracted successfully' : res.output })
          await load(currentPath, 'left')
        }
      })
    }
    if (entry && (entry.ext === 'gz' || entry.ext === 'tar')) {
      items.push({
        label: 'Extract here', icon: '📤',
        action: async () => {
          const res = await fmApi.untar(siteId, entryPath!, base)
          setOpResult({ ok: res.ok, msg: res.ok ? 'Extracted successfully' : res.output })
          await load(currentPath, 'left')
        }
      })
    }

    items.push({ separator: true })

    items.push({
      label: 'Download', icon: '⬇️', disabled: !entry || entry.type === 'dir',
      action: () => {
        if (!entryPath || !entry) return
        const a = document.createElement('a')
        a.href = fmApi.downloadUrl(siteId, entryPath)
        a.download = entry.name
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
      }
    })
    items.push({
      label: 'Download as ZIP', icon: '📦',
      disabled: targetPaths.length === 0,
      action: () => fmApi.downloadZip(siteId, targetPaths, 'download')
    })

    items.push({ separator: true })

    items.push({
      label: 'Copy path', icon: '🔗',
      disabled: !entryPath,
      action: () => {
        navigator.clipboard.writeText(entryPath ?? '').catch(() => {})
        setOpResult({ ok: true, msg: 'Path copied to clipboard' })
      }
    })

    items.push({ separator: true })

    items.push({
      label: 'Permissions (chmod)', icon: '🔐',
      action: () => { setChmodMode(entry?.permissions ?? '644'); setChmodOpen(true) }
    })
    items.push({
      label: 'Owner (chown)', icon: '👤',
      action: () => setChownOpen(true)
    })

    if (entry) {
      items.push({
        label: 'Properties', icon: 'ℹ️',
        action: async () => {
          const p = await fmApi.properties(siteId, entryPath!)
          setPropsEntry(p); setPropsOpen(true)
        }
      })
    }

    return items
  }, [siteId, currentPath, rightPath, selected, rightSelected, clipboard, dual, activePane, handleOpen, load])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (editorOpen) return
    const pane = activePane
    const sel = pane === 'left' ? selected : rightSelected
    const base = pane === 'left' ? currentPath : rightPath
    const ents = pane === 'left' ? entries : rightEntries
    const selPaths = Array.from(sel).map(n => joinPath(base === '/' ? '' : base, n))

    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      setClipboard({ op: 'copy', paths: selPaths })
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'x') {
      setClipboard({ op: 'cut', paths: selPaths })
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'v' && clipboard) {
      ;(async () => {
        if (clipboard.op === 'copy') await fmApi.copy(siteId, clipboard.paths, base)
        else { await fmApi.move(siteId, clipboard.paths, base); setClipboard(null) }
        await load(currentPath, 'left')
        if (dual) await load(rightPath, 'right')
      })()
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault()
      if (pane === 'left') setSelected(new Set(ents.map(en => en.name)))
      else setRightSelected(new Set(ents.map(en => en.name)))
    } else if (e.key === 'F2') {
      if (sel.size === 1) {
        const name = Array.from(sel)[0]
        const full = joinPath(base === '/' ? '' : base, name)
        setRenameFrom(full); setRenameTo(name); setRenameOpen(true)
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selPaths.length > 0 && confirm(`Delete ${selPaths.length} item(s)?`)) {
        fmApi.delete(siteId, selPaths).then(() => {
          if (pane === 'left') setSelected(new Set())
          else setRightSelected(new Set())
          load(currentPath, 'left')
          if (dual) load(rightPath, 'right')
        })
      }
    }
  }, [editorOpen, activePane, selected, rightSelected, currentPath, rightPath, clipboard, entries, rightEntries, siteId, dual, load])

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = async (files: File[], dest?: string) => {
    const target = dest ?? (activePane === 'left' ? currentPath : rightPath)
    setUploadProgress(0)
    try {
      const res = await fmApi.upload(siteId, target, files, p => setUploadProgress(p))
      const failed = res.results.filter(r => !r.ok)
      setOpResult({
        ok: failed.length === 0,
        msg: failed.length === 0
          ? `Uploaded ${files.length} file(s)`
          : `${files.length - failed.length} uploaded, ${failed.length} failed: ${failed.map(f => f.filename).join(', ')}`
      })
      await load(currentPath, 'left')
      if (dual) await load(rightPath, 'right')
    } catch (e: unknown) {
      setOpResult({ ok: false, msg: e instanceof Error ? e.message : 'Upload failed' })
    } finally {
      setUploadProgress(null)
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    setSearching(true)
    try {
      const res = await fmApi.search(siteId, currentPath, searchQuery)
      setSearchResults(res.results)
    } catch {
      setSearchResults([])
    } finally {
      setSearching(false)
    }
  }

  // ── Monaco onMount ─────────────────────────────────────────────────────────
  const handleEditorMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleEditorSave()
    })
  }

  // ── Breadcrumb ─────────────────────────────────────────────────────────────
  const breadcrumbs = currentPath.split('/').filter(Boolean)

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '75vh', gap: 0, outline: 'none' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
        borderBottom: '1px solid var(--oc-border)', flexWrap: 'wrap', flexShrink: 0,
        background: 'var(--oc-bg-secondary)'
      }}>
        <Button size="slim" onClick={() => { setNewNameIsDir(false); setNewNameValue(''); setNewNameOpen(true) }}>+ File</Button>
        <Button size="slim" onClick={() => { setNewNameIsDir(true); setNewNameValue(''); setNewNameOpen(true) }}>+ Folder</Button>
        <Button size="slim" onClick={() => fileInputRef.current?.click()}>⬆ Upload</Button>
        <input
          ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
          onChange={e => { if (e.target.files) handleUpload(Array.from(e.target.files)); e.target.value = '' }}
        />
        <div style={{ width: 1, height: 20, background: 'var(--oc-border)' }} />
        <Button size="slim" variant={dual ? 'primary' : 'secondary'} onClick={() => setDual(d => !d)}>⊞ Dual Pane</Button>
        <Button size="slim" variant={showHidden ? 'primary' : 'secondary'} onClick={() => setShowHidden(h => !h)}>👁 Hidden</Button>
        <div style={{ width: 1, height: 20, background: 'var(--oc-border)' }} />
        <div style={{ flex: 1, minWidth: 160, maxWidth: 260, display: 'flex', gap: 4 }}>
          <div style={{ flex: 1 }}>
            <TextField
              label=""
              labelHidden
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder="Search files…"
              autoComplete="off"
              clearButton
              onClearButtonClick={() => { setSearchQuery(''); setSearchResults(null) }}
            />
          </div>
          <Button size="slim" onClick={handleSearch} loading={searching}>Go</Button>
        </div>
        {clipboard && (
          <Badge tone="info">
            {`${clipboard.op === 'copy' ? 'Copied' : 'Cut'}: ${clipboard.paths.length} item(s)`}
          </Badge>
        )}
        {uploadProgress !== null && (
          <Badge tone="attention">{`Uploading ${uploadProgress}%`}</Badge>
        )}
        <Button size="slim" variant="plain" onClick={() => load(currentPath, 'left')}>↻ Refresh</Button>
      </div>

      {/* ── Op result banner ─────────────────────────────────────────────── */}
      {opResult && (
        <Banner tone={opResult.ok ? 'success' : 'critical'} onDismiss={() => setOpResult(null)}>
          {opResult.msg}
        </Banner>
      )}

      {/* ── Search results ────────────────────────────────────────────────── */}
      {searchResults && (
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--oc-border)', flexShrink: 0 }}>
          <InlineStack gap="200" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">{searchResults.length} results</Text>
            {searchResults.slice(0, 20).map(r => (
              <button
                key={r.path}
                onClick={() => {
                  setSearchResults(null)
                  const dir = r.path.includes('/') ? r.path.split('/').slice(0, -1).join('/') || '/' : '/'
                  setCurrentPath(dir)
                }}
                style={{
                  background: 'none', border: '1px solid var(--oc-border)', borderRadius: 4,
                  padding: '2px 8px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace'
                }}
              >
                {r.path}
              </button>
            ))}
          </InlineStack>
        </div>
      )}

      {/* ── Breadcrumb ────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0, padding: '6px 12px',
        borderBottom: '1px solid var(--oc-border)', flexShrink: 0
      }}>
        <button
          onClick={() => setCurrentPath('/')}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', color: 'var(--oc-accent)',
            fontSize: 13, padding: '0 4px', fontFamily: 'monospace'
          }}
        >~</button>
        {breadcrumbs.map((part, i) => {
          const partial = '/' + breadcrumbs.slice(0, i + 1).join('/')
          return (
            <span key={i} style={{ display: 'flex', alignItems: 'center', fontFamily: 'monospace', fontSize: 13 }}>
              <span style={{ color: 'var(--oc-text-subdued)', padding: '0 2px' }}>/</span>
              <button
                onClick={() => setCurrentPath(partial)}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: i === breadcrumbs.length - 1 ? 'var(--p-color-text)' : 'var(--oc-accent)',
                  fontFamily: 'monospace', fontSize: 13, padding: '0 2px',
                  fontWeight: i === breadcrumbs.length - 1 ? 600 : 400
                }}
              >{part}</button>
            </span>
          )
        })}
      </div>

      {/* ── Main body ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', gap: 8, padding: 8 }}>
        {/* Sidebar bookmarks */}
        <div style={{ width: 140, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text as="p" variant="bodySm" tone="subdued" fontWeight="semibold">BOOKMARKS</Text>
          {BOOKMARKS.map(b => (
            <button
              key={b.path}
              onClick={() => setCurrentPath(b.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 8px', borderRadius: 6, border: 'none',
                background: currentPath === b.path ? 'rgba(69,143,255,0.15)' : 'none',
                color: currentPath === b.path ? 'var(--oc-accent)' : 'var(--p-color-text)',
                cursor: 'pointer', fontSize: 13, textAlign: 'left', width: '100%',
                fontWeight: currentPath === b.path ? 600 : 400
              }}
            >
              <span>{b.icon}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
            </button>
          ))}
        </div>

        {/* File panes */}
        <div style={{ flex: 1, display: 'flex', gap: 8, overflow: 'hidden', position: 'relative' }}>
          <FilePane
            siteId={siteId}
            currentPath={currentPath}
            entries={entries}
            selected={activePane === 'left' ? selected : new Set<string>()}
            loading={loading}
            sort={sort}
            sortDir={sortDir}
            onNavigate={p => setCurrentPath(p)}
            onSelect={(name, multi, range) => handleSelect(name, multi, range, 'left')}
            onOpen={entry => handleOpen(entry, 'left')}
            onContextMenu={(e, entry) => { setActivePane('left'); setCtxMenu({ x: e.clientX, y: e.clientY, entry }) }}
            onSort={handleSort}
            onDrop={files => handleUpload(files, currentPath)}
          />
          {dual && (
            <FilePane
              siteId={siteId}
              currentPath={rightPath}
              entries={rightEntries}
              selected={activePane === 'right' ? rightSelected : new Set<string>()}
              loading={rightLoading}
              sort={sort}
              sortDir={sortDir}
              onNavigate={p => setRightPath(p)}
              onSelect={(name, multi, range) => handleSelect(name, multi, range, 'right')}
              onOpen={entry => handleOpen(entry, 'right')}
              onContextMenu={(e, entry) => { setActivePane('right'); setCtxMenu({ x: e.clientX, y: e.clientY, entry }) }}
              onSort={handleSort}
              onDrop={files => handleUpload(files, rightPath)}
            />
          )}
        </div>
      </div>

      {/* ── Context Menu ─────────────────────────────────────────────────── */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          items={contextMenuItems(ctxMenu.entry)}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* ── Monaco Editor Modal ───────────────────────────────────────────── */}
      {editorOpen && (
        <Modal
          open
          title={`Edit: ${editorPath}${editorDirty ? ' •' : ''}`}
          onClose={() => {
            if (editorDirty && !confirm('Discard unsaved changes?')) return
            setEditorOpen(false)
          }}
          primaryAction={{ content: 'Save', loading: editorSaving, onAction: handleEditorSave }}
          secondaryActions={[{
            content: 'Close', onAction: () => {
              if (editorDirty && !confirm('Discard unsaved changes?')) return
              setEditorOpen(false)
            }
          }]}
          size="large"
        >
          <Modal.Section flush>
            {editorError && (
              <div style={{ padding: '8px 16px' }}>
                <Banner tone="critical" onDismiss={() => setEditorError(null)}>{editorError}</Banner>
              </div>
            )}
            <div style={{ height: '65vh' }}>
              <Editor
                height="100%"
                language={editorLang}
                value={editorContent}
                onChange={v => { setEditorContent(v ?? ''); setEditorDirty(true) }}
                options={{
                  fontSize: 13,
                  minimap: { enabled: true },
                  lineNumbers: 'on',
                  wordWrap: 'on',
                  folding: true,
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                }}
                onMount={handleEditorMount}
              />
            </div>
          </Modal.Section>
        </Modal>
      )}

      {/* ── Rename Modal ──────────────────────────────────────────────────── */}
      <Modal
        open={renameOpen}
        title="Rename"
        onClose={() => setRenameOpen(false)}
        primaryAction={{
          content: 'Rename', onAction: async () => {
            const dir = renameFrom.split('/').slice(0, -1).join('/') || '/'
            await fmApi.rename(siteId, renameFrom, joinPath(dir === '/' ? '' : dir, renameTo))
            setRenameOpen(false)
            await load(currentPath, 'left')
            if (dual) await load(rightPath, 'right')
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setRenameOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="New name"
            value={renameTo}
            onChange={setRenameTo}
            autoComplete="off"
          />
        </Modal.Section>
      </Modal>

      {/* ── New File/Folder Modal ─────────────────────────────────────────── */}
      <Modal
        open={newNameOpen}
        title={newNameIsDir ? 'New Folder' : 'New File'}
        onClose={() => setNewNameOpen(false)}
        primaryAction={{
          content: 'Create', onAction: async () => {
            const base = activePane === 'left' ? currentPath : rightPath
            const fullPath = joinPath(base === '/' ? '' : base, newNameValue)
            if (newNameIsDir) await fmApi.mkdir(siteId, fullPath)
            else await fmApi.touch(siteId, fullPath)
            setNewNameOpen(false)
            await load(currentPath, 'left')
            if (dual) await load(rightPath, 'right')
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setNewNameOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label={newNameIsDir ? 'Folder name' : 'File name'}
            value={newNameValue}
            onChange={setNewNameValue}
            autoComplete="off"
            placeholder={newNameIsDir ? 'new-folder' : 'file.php'}
          />
        </Modal.Section>
      </Modal>

      {/* ── Zip/Tar name Modal ────────────────────────────────────────────── */}
      <Modal
        open={zipNameOpen}
        title={`Compress to ${archiveFormat === 'zip' ? 'ZIP' : 'TAR.GZ'}`}
        onClose={() => setZipNameOpen(false)}
        primaryAction={{
          content: 'Compress', onAction: async () => {
            const pane = activePane
            const base = pane === 'left' ? currentPath : rightPath
            const sel = pane === 'left' ? selected : rightSelected
            const selPaths = Array.from(sel).map(n => joinPath(base === '/' ? '' : base, n))
            const destPath = joinPath(base === '/' ? '' : base, zipNameValue)
            setZipNameOpen(false)
            try {
              if (archiveFormat === 'zip') await fmApi.zip(siteId, selPaths, destPath)
              else await fmApi.tar(siteId, selPaths, destPath)
              setOpResult({ ok: true, msg: `Archive created: ${zipNameValue}` })
            } catch (e: unknown) {
              setOpResult({ ok: false, msg: e instanceof Error ? e.message : 'Compress failed' })
            }
            await load(currentPath, 'left')
            if (dual) await load(rightPath, 'right')
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setZipNameOpen(false) }]}
      >
        <Modal.Section>
          <TextField label="Archive name" value={zipNameValue} onChange={setZipNameValue} autoComplete="off" />
        </Modal.Section>
      </Modal>

      {/* ── chmod Modal ───────────────────────────────────────────────────── */}
      <Modal
        open={chmodOpen}
        title="Change Permissions (chmod)"
        onClose={() => setChmodOpen(false)}
        primaryAction={{
          content: 'Apply', onAction: async () => {
            const pane = activePane
            const base = pane === 'left' ? currentPath : rightPath
            const sel = pane === 'left' ? selected : rightSelected
            const selPaths = Array.from(sel).map(n => joinPath(base === '/' ? '' : base, n))
            await fmApi.chmod(siteId, selPaths, chmodMode, chmodRecursive)
            setChmodOpen(false)
            setOpResult({ ok: true, msg: `Permissions set to ${chmodMode}` })
            await load(currentPath, 'left')
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setChmodOpen(false) }]}
      >
        <Modal.Section>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <TextField label="Octal mode (e.g. 755, 644)" value={chmodMode} onChange={setChmodMode} autoComplete="off" />
            <Checkbox label="Apply recursively" checked={chmodRecursive} onChange={setChmodRecursive} />
            <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--oc-text-subdued)' }}>
              {['7', '6', '5', '4', '0'].map(n => (
                <div key={n}>
                  {n} = {[4, 2, 1].map(b => parseInt(n) & b ? (b === 4 ? 'r' : b === 2 ? 'w' : 'x') : '-').join('')}
                  {n === '7' ? ' (read+write+exec)' : n === '6' ? ' (read+write)' : n === '5' ? ' (read+exec)' : n === '4' ? ' (read only)' : ' (none)'}
                </div>
              ))}
            </div>
          </div>
        </Modal.Section>
      </Modal>

      {/* ── chown Modal ───────────────────────────────────────────────────── */}
      <Modal
        open={chownOpen}
        title="Change Owner (chown)"
        onClose={() => setChownOpen(false)}
        primaryAction={{
          content: 'Apply', onAction: async () => {
            const pane = activePane
            const base = pane === 'left' ? currentPath : rightPath
            const sel = pane === 'left' ? selected : rightSelected
            const selPaths = Array.from(sel).map(n => joinPath(base === '/' ? '' : base, n))
            await fmApi.chown(siteId, selPaths, chownOwner, chownGroup, chownRecursive)
            setChownOpen(false)
            setOpResult({ ok: true, msg: `Owner set to ${chownOwner}:${chownGroup}` })
            await load(currentPath, 'left')
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setChownOpen(false) }]}
      >
        <Modal.Section>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <TextField label="Owner" value={chownOwner} onChange={setChownOwner} autoComplete="off" />
            <TextField label="Group" value={chownGroup} onChange={setChownGroup} autoComplete="off" />
            <Checkbox label="Apply recursively" checked={chownRecursive} onChange={setChownRecursive} />
          </div>
        </Modal.Section>
      </Modal>

      {/* ── Properties Modal ──────────────────────────────────────────────── */}
      <Modal
        open={propsOpen}
        title="Properties"
        onClose={() => setPropsOpen(false)}
        secondaryActions={[{ content: 'Close', onAction: () => setPropsOpen(false) }]}
      >
        <Modal.Section>
          {propsEntry && (
            <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px 16px', fontSize: 13 }}>
              {([
                ['Name',        propsEntry.name],
                ['Type',        propsEntry.type],
                ['Size',        fmtSize(propsEntry.totalSize)],
                ['Modified',    fmtDate(propsEntry.modified)],
                ['Owner',       `${propsEntry.owner}:${propsEntry.group}`],
                ['Permissions', `${propsEntry.permsDisplay} (${propsEntry.permissions})`],
              ] as [string, string][]).map(([k, v]) => (
                <React.Fragment key={k}>
                  <Text as="span" variant="bodySm" tone="subdued" fontWeight="semibold">{k}</Text>
                  <Text as="span" variant="bodySm">{v}</Text>
                </React.Fragment>
              ))}
            </div>
          )}
        </Modal.Section>
      </Modal>

      {/* ── Preview Modal ─────────────────────────────────────────────────── */}
      {previewEntry && (
        <PreviewModal siteId={siteId} entry={previewEntry} onClose={() => setPreviewEntry(null)} />
      )}
    </div>
  )
}
