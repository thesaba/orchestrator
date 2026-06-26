import {
  BlockStack, InlineStack, Text, Button, Badge, Banner,
  Card, DataTable, Modal, TextField, Select, Checkbox,
  Divider, SkeletonBodyText
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { api, BackupFile, BackupSchedule, SiteDatabase, dbManageApi, Site } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { QueryRunnerModal } from './QueryRunnerModal'

interface Props {
  siteId: number
  site: Site
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function buildDaysLabel(days: string): string {
  if (days === '*') return 'Every day'
  const names = days.split(',').map(d => DAY_LABELS[Number(d)] ?? d)
  return names.join(', ')
}

function buildCronPreview(hour: number, minute: number, days: string): string {
  const h = String(hour).padStart(2, '0')
  const m = String(minute).padStart(2, '0')
  const dayLabel = buildDaysLabel(days)
  return `${dayLabel} at ${h}:${m}`
}

export function DatabaseTab({ siteId, site }: Props) {
  const { isAdmin } = useAuth()

  // ── Databases ────────────────────────────────────────────────────────────
  const [databases,     setDatabases]     = useState<SiteDatabase[]>([])
  const [dbsLoaded,     setDbsLoaded]     = useState(false)
  const [dbsError,      setDbsError]      = useState('')
  const [addDbOpen,     setAddDbOpen]     = useState(false)
  const [addDbName,     setAddDbName]     = useState('')
  const [addDbUser,     setAddDbUser]     = useState('')
  const [addDbSaving,   setAddDbSaving]   = useState(false)
  const [addDbError,    setAddDbError]    = useState('')
  const [deletingDb,    setDeletingDb]    = useState<number | null>(null)
  const [pmaLoadingId,  setPmaLoadingId]  = useState<number | null>(null)
  const [queryDb,       setQueryDb]       = useState<SiteDatabase | null>(null)
  const [importDb,      setImportDb]      = useState<SiteDatabase | null>(null)
  const [importFile,    setImportFile]    = useState<File | null>(null)
  const [importing,     setImporting]     = useState(false)
  const [importError,   setImportError]   = useState('')
  const [importWarning, setImportWarning] = useState('')

  // ── Backups ──────────────────────────────────────────────────────────────
  const [backups,        setBackups]        = useState<BackupFile[]>([])
  const [backupsLoaded,  setBackupsLoaded]  = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [backupError,    setBackupError]    = useState('')
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null)

  // ── Backup schedule ───────────────────────────────────────────────────────
  const [scheduleActive,  setScheduleActive]  = useState(false)
  const [scheduleHour,    setScheduleHour]    = useState(2)
  const [scheduleMinute,  setScheduleMinute]  = useState(0)
  const [scheduleDays,    setScheduleDays]    = useState('*')
  const [scheduleLoaded,  setScheduleLoaded]  = useState(false)
  const [savingSchedule,  setSavingSchedule]  = useState(false)
  const [customDays,      setCustomDays]      = useState<boolean[]>([false,false,false,false,false,false,false])
  const [dayMode,         setDayMode]         = useState<'daily' | 'custom'>('daily')

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    dbManageApi.list(siteId)
      .then(r => { setDatabases(r.databases); setDbsLoaded(true) })
      .catch(e => { setDbsError(e.message); setDbsLoaded(true) })

    api.database.listBackups(siteId)
      .then(r => { setBackups(r.backups); setBackupsLoaded(true) })
      .catch(() => setBackupsLoaded(true))

    api.database.getBackupSchedule(siteId)
      .then(r => {
        setScheduleActive(r.active)
        setScheduleHour(r.hour)
        setScheduleMinute(r.minute ?? 0)
        const days = r.days ?? '*'
        setScheduleDays(days)
        if (days === '*') {
          setDayMode('daily')
        } else {
          setDayMode('custom')
          const arr = [false,false,false,false,false,false,false]
          days.split(',').forEach(d => { const n = Number(d); if (n >= 0 && n <= 6) arr[n] = true })
          setCustomDays(arr)
        }
        setScheduleLoaded(true)
      })
      .catch(() => setScheduleLoaded(true))
  }, [siteId])

  // ── Database add ──────────────────────────────────────────────────────────
  const handleAddDb = useCallback(async () => {
    if (!addDbName.trim() || !addDbUser.trim()) return
    setAddDbSaving(true)
    setAddDbError('')
    try {
      const db = await dbManageApi.create(siteId, { dbName: addDbName.trim(), dbUser: addDbUser.trim() })
      setDatabases(d => [...d, db])
      setAddDbOpen(false)
      setAddDbName('')
      setAddDbUser('')
    } catch (e: unknown) {
      setAddDbError((e as Error).message)
    } finally {
      setAddDbSaving(false)
    }
  }, [siteId, addDbName, addDbUser])

  const handleOpenPma = useCallback(async (db: SiteDatabase) => {
    setPmaLoadingId(db.id)
    try {
      const { url } = await dbManageApi.openPma(siteId, db.id)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      setPmaLoadingId(null)
    }
  }, [siteId])

  const handleDeleteDb = useCallback(async (db: SiteDatabase) => {
    if (!confirm(`Drop database "${db.dbName}" and user "${db.dbUser}"? This cannot be undone.`)) return
    setDeletingDb(db.id)
    try {
      await dbManageApi.remove(siteId, db.id)
      setDatabases(d => d.filter(x => x.id !== db.id))
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      setDeletingDb(null)
    }
  }, [siteId])

  const handleImport = useCallback(async () => {
    if (!importDb || !importFile) return
    setImporting(true)
    setImportError('')
    setImportWarning('')
    try {
      const res = await dbManageApi.importSql(siteId, importDb.id, importFile)
      if (res.warnings) setImportWarning(res.warnings)
      else {
        setImportDb(null)
        setImportFile(null)
      }
    } catch (e: unknown) {
      setImportError((e as Error).message)
    } finally {
      setImporting(false)
    }
  }, [siteId, importDb, importFile])

  // ── Backup ────────────────────────────────────────────────────────────────
  const handleCreateBackup = useCallback(async () => {
    setCreatingBackup(true)
    setBackupError('')
    try {
      await api.database.createBackup(siteId)
      const r = await api.database.listBackups(siteId)
      setBackups(r.backups)
    } catch (e: unknown) {
      setBackupError((e as Error).message)
    } finally {
      setCreatingBackup(false)
    }
  }, [siteId])

  const handleDeleteBackup = useCallback(async (name: string) => {
    setDeletingBackup(name)
    try {
      await api.database.deleteBackup(siteId, name)
      setBackups(b => b.filter(x => x.name !== name))
    } catch {
      // ignore
    } finally {
      setDeletingBackup(null)
    }
  }, [siteId])

  // ── Backup schedule ───────────────────────────────────────────────────────
  const computedDays = dayMode === 'daily'
    ? '*'
    : customDays.map((on, i) => on ? String(i) : null).filter(Boolean).join(',') || '*'

  const handleToggleSchedule = useCallback(async () => {
    setSavingSchedule(true)
    try {
      if (scheduleActive) {
        await api.database.disableBackupSchedule(siteId)
        setScheduleActive(false)
      } else {
        await api.database.enableBackupSchedule(siteId, { hour: scheduleHour, minute: scheduleMinute, days: computedDays })
        setScheduleActive(true)
        setScheduleDays(computedDays)
      }
    } catch {
      // ignore
    } finally {
      setSavingSchedule(false)
    }
  }, [siteId, scheduleActive, scheduleHour, scheduleMinute, computedDays])

  const handleSaveSchedule = useCallback(async () => {
    if (!scheduleActive) return
    setSavingSchedule(true)
    try {
      await api.database.enableBackupSchedule(siteId, { hour: scheduleHour, minute: scheduleMinute, days: computedDays })
      setScheduleDays(computedDays)
    } catch {
      // ignore
    } finally {
      setSavingSchedule(false)
    }
  }, [siteId, scheduleHour, scheduleMinute, computedDays, scheduleActive])

  const formatBytes = (b: number) => {
    if (b < 1024) return `${b} B`
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
    return `${(b / 1024 / 1024).toFixed(1)} MB`
  }

  const hourOptions = Array.from({ length: 24 }, (_, i) => ({ label: `${String(i).padStart(2, '0')}:00`, value: String(i) }))
  const minuteOptions = [
    { label: ':00', value: '0' },
    { label: ':15', value: '15' },
    { label: ':30', value: '30' },
    { label: ':45', value: '45' }
  ]

  return (
    <BlockStack gap="500">
      {/* ── Databases ── */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Databases</Text>
            {isAdmin && (
              <Button variant="primary" onClick={() => setAddDbOpen(true)}>Add Database</Button>
            )}
          </InlineStack>

          {!dbsLoaded && <SkeletonBodyText lines={3} />}

          {dbsError && <Banner tone="critical">{dbsError}</Banner>}

          {dbsLoaded && databases.length === 0 && (
            <Text as="p" tone="subdued">
              {site.dbName
                ? `Primary database: ${site.dbName} (managed by provisioner)`
                : 'No databases configured. Add one above or configure credentials in the Config tab.'}
            </Text>
          )}

          {dbsLoaded && databases.length > 0 && (
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text', 'text']}
              headings={['Database', 'User', 'Type', 'Created', 'Actions']}
              rows={databases.map(db => [
                db.dbName,
                db.dbUser,
                db.isPrimary ? <Badge tone="info">Primary</Badge> : <Badge>Secondary</Badge>,
                new Date(db.createdAt).toLocaleDateString(),
                <InlineStack gap="200">
                  <Button size="micro" onClick={() => setQueryDb(db)}>Query</Button>
                  <Button size="micro" onClick={() => { setImportDb(db); setImportFile(null); setImportError(''); setImportWarning('') }}>Import</Button>
                  <Button size="micro" loading={pmaLoadingId === db.id} onClick={() => handleOpenPma(db)}>
                    phpMyAdmin
                  </Button>
                  {isAdmin && !db.isPrimary && (
                    <Button
                      size="micro"
                      tone="critical"
                      loading={deletingDb === db.id}
                      onClick={() => handleDeleteDb(db)}
                    >
                      Drop
                    </Button>
                  )}
                </InlineStack>
              ])}
            />
          )}

          {/* Show legacy site.dbName if no SiteDatabase records yet */}
          {dbsLoaded && databases.length === 0 && site.dbName && (
            <Banner tone="info">
              Primary database <strong>{site.dbName}</strong> was created during provisioning.
              It will appear here once migrated or when a new database is added.
            </Banner>
          )}
        </BlockStack>
      </Card>

      {/* ── Backups ── */}
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Backups</Text>
            <Button
              variant="primary"
              loading={creatingBackup}
              onClick={handleCreateBackup}
            >
              Create Backup
            </Button>
          </InlineStack>

          {backupError && <Banner tone="critical">{backupError}</Banner>}

          {!backupsLoaded && <SkeletonBodyText lines={3} />}

          {backupsLoaded && backups.length === 0 && (
            <Text as="p" tone="subdued">No backups yet.</Text>
          )}

          {backupsLoaded && backups.length > 0 && (
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text']}
              headings={['File', 'Size', 'Created', 'Actions']}
              rows={backups.map(b => [
                b.name,
                formatBytes(b.sizeBytes),
                new Date(b.createdAt).toLocaleString(),
                <InlineStack gap="200">
                  <Button
                    size="micro"
                    onClick={() => api.database.downloadBackup(siteId, b.name)}
                  >
                    Download
                  </Button>
                  <Button
                    size="micro"
                    tone="critical"
                    loading={deletingBackup === b.name}
                    onClick={() => handleDeleteBackup(b.name)}
                  >
                    Delete
                  </Button>
                </InlineStack>
              ])}
            />
          )}
        </BlockStack>
      </Card>

      {/* ── Backup Schedule ── */}
      <Card>
        <BlockStack gap="400">
          <Text as="h2" variant="headingMd">Backup Schedule</Text>

          {!scheduleLoaded && <SkeletonBodyText lines={4} />}

          {scheduleLoaded && (
            <>
              <InlineStack gap="400" wrap={false} blockAlign="center">
                <Select
                  label="Hour"
                  options={hourOptions}
                  value={String(scheduleHour)}
                  onChange={v => setScheduleHour(Number(v))}
                />
                <Select
                  label="Minute"
                  options={minuteOptions}
                  value={String(scheduleMinute)}
                  onChange={v => setScheduleMinute(Number(v))}
                />
                <Select
                  label="Frequency"
                  options={[
                    { label: 'Every day', value: 'daily' },
                    { label: 'Custom days', value: 'custom' }
                  ]}
                  value={dayMode}
                  onChange={v => setDayMode(v as 'daily' | 'custom')}
                />
              </InlineStack>

              {dayMode === 'custom' && (
                <InlineStack gap="300" wrap>
                  {DAY_LABELS.map((label, i) => (
                    <Checkbox
                      key={label}
                      label={label}
                      checked={customDays[i]}
                      onChange={checked => {
                        setCustomDays(d => { const n = [...d]; n[i] = checked; return n })
                      }}
                    />
                  ))}
                </InlineStack>
              )}

              <Text as="p" variant="bodySm" tone="subdued">
                Preview: <strong>{buildCronPreview(scheduleHour, scheduleMinute, computedDays)}</strong>
              </Text>

              <Divider />

              <InlineStack gap="300">
                <Button
                  variant={scheduleActive ? 'secondary' : 'primary'}
                  loading={savingSchedule}
                  tone={scheduleActive ? 'critical' : undefined}
                  onClick={handleToggleSchedule}
                >
                  {scheduleActive ? 'Disable Schedule' : 'Enable Schedule'}
                </Button>
                {scheduleActive && (
                  <Button loading={savingSchedule} onClick={handleSaveSchedule}>
                    Save Changes
                  </Button>
                )}
              </InlineStack>

              {scheduleActive && (
                <Banner tone="success">
                  Automatic backups are enabled — {buildCronPreview(scheduleHour, scheduleMinute, scheduleDays)}
                </Banner>
              )}
            </>
          )}
        </BlockStack>
      </Card>

      {/* ── Add Database Modal ── */}
      <Modal
        open={addDbOpen}
        onClose={() => { setAddDbOpen(false); setAddDbError('') }}
        title="Add Database"
        primaryAction={{ content: 'Create', onAction: handleAddDb, loading: addDbSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setAddDbOpen(false); setAddDbError('') } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {addDbError && <Banner tone="critical">{addDbError}</Banner>}
            <TextField
              label="Database name"
              value={addDbName}
              onChange={setAddDbName}
              autoComplete="off"
              placeholder="myapp_db"
              helpText="Only letters, numbers, and underscores"
            />
            <TextField
              label="Database user"
              value={addDbUser}
              onChange={setAddDbUser}
              autoComplete="off"
              placeholder="myapp_user"
              helpText="A new MySQL user will be created with GRANT ALL on this database"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Query Runner Modal ── */}
      {queryDb && (
        <QueryRunnerModal
          open={!!queryDb}
          onClose={() => setQueryDb(null)}
          siteId={siteId}
          db={queryDb}
        />
      )}

      {/* ── Import SQL Modal ── */}
      <Modal
        open={!!importDb}
        onClose={() => { setImportDb(null); setImportFile(null); setImportError(''); setImportWarning('') }}
        title={`Import SQL — ${importDb?.dbName ?? ''}`}
        primaryAction={{
          content: importing ? 'Importing…' : 'Import',
          onAction: handleImport,
          loading: importing,
          disabled: !importFile
        }}
        secondaryActions={[{
          content: 'Cancel',
          onAction: () => { setImportDb(null); setImportFile(null); setImportError(''); setImportWarning('') }
        }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {importError && (
              <Banner tone="critical" title="Import failed">
                <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {importError}
                </pre>
              </Banner>
            )}
            {importWarning && (
              <Banner tone="warning" title="Import completed with warnings">
                <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {importWarning}
                </pre>
              </Banner>
            )}
            {!importWarning && (
              <>
                <Text as="p" variant="bodySm" tone="subdued">
                  Upload a <strong>.sql</strong> or <strong>.sql.gz</strong> dump file.
                  All statements will be executed against <strong>{importDb?.dbName}</strong> using root credentials.
                  Existing data will not be dropped unless your dump includes DROP TABLE statements.
                </Text>
                <div>
                  <input
                    type="file"
                    accept=".sql,.sql.gz,.gz"
                    style={{ display: 'block', marginTop: 8 }}
                    onChange={e => {
                      setImportFile(e.target.files?.[0] ?? null)
                      setImportError('')
                    }}
                  />
                  {importFile && (
                    <Text as="p" variant="bodySm" tone="subdued" >
                      {importFile.name} ({(importFile.size / 1024 / 1024).toFixed(2)} MB)
                    </Text>
                  )}
                </div>
              </>
            )}
            {importWarning && (
              <Button onClick={() => { setImportDb(null); setImportFile(null); setImportWarning('') }}>
                Close
              </Button>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}
