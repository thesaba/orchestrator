import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Card, BlockStack, InlineStack, Text, Button, ButtonGroup, Select, Popover,
  ActionList, Modal, TextField, Tooltip, Badge, Icon
} from '@shopify/polaris'
import {
  DragHandleIcon, PlusIcon, XIcon, LayoutColumns2Icon, LayoutSectionIcon,
  SettingsIcon, ResetIcon
} from '@shopify/polaris-icons'
import { api, DashboardPreset } from '../../api/client'

export type WidgetWidth = 'half' | 'full'

export interface WidgetDef {
  id: string
  title: string
  defaultWidth: WidgetWidth
  node: ReactNode
}

interface LayoutItem {
  id: string
  width: WidgetWidth
  visible: boolean
}

// Merge a saved layout with the current widget catalog: keep saved order/size/
// visibility for widgets that still exist, drop unknown ids, and append any
// newly-shipped widgets (not in the saved layout) as visible at the end. This
// keeps old saved layouts working as the app adds/removes widgets over time.
function reconcile(saved: LayoutItem[] | null, catalog: WidgetDef[]): LayoutItem[] {
  const known = new Map(catalog.map((w) => [w.id, w]))
  const out: LayoutItem[] = []
  const seen = new Set<string>()
  for (const item of saved ?? []) {
    if (known.has(item.id) && !seen.has(item.id)) {
      out.push({ id: item.id, width: item.width === 'full' ? 'full' : 'half', visible: item.visible !== false })
      seen.add(item.id)
    }
  }
  for (const w of catalog) {
    if (!seen.has(w.id)) { out.push({ id: w.id, width: w.defaultWidth, visible: true }); seen.add(w.id) }
  }
  return out
}

function parseConfig(config: string | null): LayoutItem[] | null {
  if (!config) return null
  try {
    const parsed = JSON.parse(config)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

/**
 * A configurable widget grid: drag to reorder, toggle each widget between half
 * and full width, show/hide widgets, and save/apply named layout presets. The
 * working layout auto-saves per user (server-side); presets are also per user.
 */
export function DashboardGrid({ catalog }: { catalog: WidgetDef[] }) {
  const [layout, setLayout] = useState<LayoutItem[]>(() => reconcile(null, catalog))
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [presets, setPresets] = useState<DashboardPreset[]>([])
  const [activePreset, setActivePreset] = useState<string>('')
  const [addOpen, setAddOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const catalogById = useMemo(() => new Map(catalog.map((w) => [w.id, w])), [catalog])

  // ── Load saved layout + presets on mount ─────────────────────────────────
  useEffect(() => {
    api.dashboard.get()
      .then((d) => {
        setLayout(reconcile(parseConfig(d.auto), catalog))
        setPresets(d.presets)
      })
      .catch(() => { /* keep default layout */ })
      .finally(() => setLoaded(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Debounced auto-save of the working layout ────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!loaded) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api.dashboard.saveAuto(JSON.stringify(layout)).catch(() => { /* best effort */ })
    }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [layout, loaded])

  // ── Mutations ────────────────────────────────────────────────────────────
  const setWidth = useCallback((id: string, width: WidgetWidth) =>
    setLayout((l) => l.map((i) => (i.id === id ? { ...i, width } : i))), [])

  const hide = useCallback((id: string) =>
    setLayout((l) => l.map((i) => (i.id === id ? { ...i, visible: false } : i))), [])

  const show = useCallback((id: string) => {
    setAddOpen(false)
    setLayout((l) => l.map((i) => (i.id === id ? { ...i, visible: true } : i)))
  }, [])

  const reorder = useCallback((draggedId: string, targetId: string) => {
    if (draggedId === targetId) return
    setLayout((l) => {
      const arr = [...l]
      const from = arr.findIndex((i) => i.id === draggedId)
      if (from < 0) return l
      const [moved] = arr.splice(from, 1)
      const to = arr.findIndex((i) => i.id === targetId)
      arr.splice(to < 0 ? arr.length : to, 0, moved)
      return arr
    })
  }, [])

  const resetDefault = useCallback(() => {
    setActivePreset('')
    setLayout(reconcile(null, catalog))
  }, [catalog])

  // ── Presets ──────────────────────────────────────────────────────────────
  const applyPreset = useCallback((name: string) => {
    setActivePreset(name)
    if (!name) { resetDefault(); return }
    const p = presets.find((x) => x.name === name)
    if (p) setLayout(reconcile(parseConfig(p.config), catalog))
  }, [presets, catalog, resetDefault])

  const saveAsPreset = useCallback(async () => {
    const name = presetName.trim()
    if (!name) return
    try {
      const saved = await api.dashboard.savePreset(name, JSON.stringify(layout))
      setPresets((ps) => [saved, ...ps.filter((p) => p.name !== name)])
      setActivePreset(name)
      setSaveOpen(false)
      setPresetName('')
    } catch { /* ignore */ }
  }, [presetName, layout])

  const deleteActivePreset = useCallback(async () => {
    const p = presets.find((x) => x.name === activePreset)
    if (!p) return
    try {
      await api.dashboard.deletePreset(p.id)
      setPresets((ps) => ps.filter((x) => x.id !== p.id))
      setActivePreset('')
    } catch { /* ignore */ }
  }, [presets, activePreset])

  // ── Render ────────────────────────────────────────────────────────────────
  const hidden = layout.filter((i) => !i.visible && catalogById.has(i.id))
  const visible = layout.filter((i) => i.visible && catalogById.has(i.id))

  const presetOptions = [
    { label: 'Default layout', value: '' },
    ...presets.map((p) => ({ label: p.name, value: p.name }))
  ]

  return (
    <BlockStack gap="400">
      {/* Toolbar */}
      <Card padding="300">
        <InlineStack align="space-between" blockAlign="center" wrap>
          <InlineStack gap="200" blockAlign="center">
            <Button
              icon={editing ? undefined : SettingsIcon}
              variant={editing ? 'primary' : 'secondary'}
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? 'Done' : 'Customize'}
            </Button>
            {editing && (
              <Text as="span" variant="bodySm" tone="subdued">
                Drag the handle to reorder · toggle width · hide widgets
              </Text>
            )}
          </InlineStack>

          <InlineStack gap="200" blockAlign="center">
            <div style={{ minWidth: 180 }}>
              <Select
                label="Preset"
                labelHidden
                options={presetOptions}
                value={activePreset}
                onChange={applyPreset}
              />
            </div>
            {editing && (
              <>
                <Popover
                  active={addOpen}
                  onClose={() => setAddOpen(false)}
                  activator={
                    <Button icon={PlusIcon} disabled={hidden.length === 0} onClick={() => setAddOpen((o) => !o)}>
                      {`Add widget${hidden.length ? ` (${hidden.length})` : ''}`}
                    </Button>
                  }
                >
                  <ActionList
                    items={hidden.map((i) => ({
                      content: catalogById.get(i.id)?.title ?? i.id,
                      onAction: () => show(i.id)
                    }))}
                  />
                </Popover>
                <Button icon={PlusIcon} onClick={() => { setPresetName(activePreset); setSaveOpen(true) }}>
                  Save as preset
                </Button>
                {activePreset && (
                  <Button tone="critical" variant="tertiary" onClick={deleteActivePreset}>Delete preset</Button>
                )}
                <Tooltip content="Reset to default layout">
                  <Button icon={ResetIcon} onClick={resetDefault} accessibilityLabel="Reset layout" />
                </Tooltip>
              </>
            )}
          </InlineStack>
        </InlineStack>
      </Card>

      {/* Grid */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        {visible.map((item) => {
          const def = catalogById.get(item.id)!
          const isDropTarget = editing && overId === item.id && dragId !== item.id
          return (
            <div
              key={item.id}
              onDragOver={(e) => { if (editing && dragId) { e.preventDefault(); setOverId(item.id) } }}
              onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, item.id); setDragId(null); setOverId(null) }}
              style={{
                width: item.width === 'full' ? '100%' : 'calc(50% - 8px)',
                minWidth: 300,
                flexGrow: item.width === 'full' ? 0 : 1,
                boxSizing: 'border-box',
                outline: isDropTarget ? '2px dashed #5c6ac4' : undefined,
                outlineOffset: 4,
                borderRadius: 12,
                opacity: dragId === item.id ? 0.5 : 1,
                transition: 'opacity 120ms'
              }}
            >
              {editing && (
                <div
                  draggable
                  onDragStart={() => setDragId(item.id)}
                  onDragEnd={() => { setDragId(null); setOverId(null) }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 8, padding: '6px 10px', marginBottom: 6,
                    background: 'var(--p-color-bg-surface-secondary, #f6f6f7)',
                    border: '1px solid var(--p-color-border, #e1e3e5)', borderRadius: 8,
                    cursor: 'grab', userSelect: 'none'
                  }}
                >
                  <InlineStack gap="150" blockAlign="center">
                    <Icon source={DragHandleIcon} tone="subdued" />
                    <Text as="span" variant="bodySm" fontWeight="medium">{def.title}</Text>
                  </InlineStack>
                  <InlineStack gap="100" blockAlign="center">
                    <ButtonGroup variant="segmented">
                      <Tooltip content="Half width">
                        <Button
                          size="micro"
                          pressed={item.width === 'half'}
                          icon={LayoutColumns2Icon}
                          onClick={() => setWidth(item.id, 'half')}
                          accessibilityLabel="Half width"
                        />
                      </Tooltip>
                      <Tooltip content="Full width">
                        <Button
                          size="micro"
                          pressed={item.width === 'full'}
                          icon={LayoutSectionIcon}
                          onClick={() => setWidth(item.id, 'full')}
                          accessibilityLabel="Full width"
                        />
                      </Tooltip>
                    </ButtonGroup>
                    <Tooltip content="Hide widget">
                      <Button size="micro" icon={XIcon} onClick={() => hide(item.id)} accessibilityLabel="Hide" />
                    </Tooltip>
                  </InlineStack>
                </div>
              )}
              <div style={{ pointerEvents: editing ? 'none' : undefined }}>
                {def.node}
              </div>
            </div>
          )
        })}
      </div>

      {visible.length === 0 && (
        <Card>
          <BlockStack gap="200" inlineAlign="center">
            <Text as="p" tone="subdued">All widgets are hidden.</Text>
            <Badge>{`${hidden.length} available`}</Badge>
          </BlockStack>
        </Card>
      )}

      {/* Save-as-preset modal */}
      <Modal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save layout as preset"
        primaryAction={{ content: 'Save', onAction: saveAsPreset, disabled: !presetName.trim() }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setSaveOpen(false) }]}
      >
        <Modal.Section>
          <TextField
            label="Preset name"
            value={presetName}
            onChange={setPresetName}
            autoComplete="off"
            placeholder="e.g. Ops view, SSL focus"
            helpText="Saving with an existing name overwrites that preset."
          />
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}
