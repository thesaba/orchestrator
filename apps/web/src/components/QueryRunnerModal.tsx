import { Modal, Button, Banner, Text, InlineStack, Badge, SkeletonBodyText } from '@shopify/polaris'
import Editor from '@monaco-editor/react'
import { useState, useCallback } from 'react'
import { dbManageApi, SiteDatabase, QueryResult } from '../api/client'

interface Props {
  open: boolean
  onClose: () => void
  siteId: number
  db: SiteDatabase
}

export function QueryRunnerModal({ open, onClose, siteId, db }: Props) {
  const [sql, setSql]         = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<QueryResult | null>(null)
  const [error, setError]     = useState('')

  const handleRun = useCallback(async () => {
    if (!sql.trim()) return
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const res = await dbManageApi.runQuery(siteId, db.id, sql)
      setResult(res)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Query failed')
    } finally {
      setLoading(false)
    }
  }, [sql, siteId, db.id])

  const handleClose = () => {
    setSql('')
    setResult(null)
    setError('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Query: ${db.dbName}`}
      size="large"
      primaryAction={{ content: 'Run Query', onAction: handleRun, loading, disabled: !sql.trim() }}
      secondaryActions={[{ content: 'Close', onAction: handleClose }]}
    >
      <Modal.Section>
        <div style={{ border: '1px solid var(--p-color-border)', borderRadius: 8, overflow: 'hidden', marginBottom: 12 }}>
          <Editor
            height="200px"
            defaultLanguage="sql"
            value={sql}
            onChange={(v) => setSql(v ?? '')}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on'
            }}
          />
        </div>

        <InlineStack gap="200" align="space-between">
          <Text as="p" variant="bodySm" tone="subdued">
            Allowed: SELECT, INSERT, UPDATE, DELETE, SHOW, DESCRIBE, EXPLAIN
          </Text>
          {result && (
            <InlineStack gap="200">
              <Badge tone={result.rowCount > 0 ? 'success' : 'info'}>
                {`${result.rowCount} row${result.rowCount !== 1 ? 's' : ''}`}
              </Badge>
              <Badge tone="info">{`${result.elapsedMs}ms`}</Badge>
            </InlineStack>
          )}
        </InlineStack>
      </Modal.Section>

      {loading && (
        <Modal.Section>
          <SkeletonBodyText lines={4} />
        </Modal.Section>
      )}

      {error && !loading && (
        <Modal.Section>
          <Banner tone="critical" title="Query error">
            <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {error}
            </pre>
          </Banner>
        </Modal.Section>
      )}

      {result && !loading && !error && (
        <Modal.Section>
          {result.truncated && (
            <Banner tone="warning" title="Results truncated">
              Showing first 1000 rows. Use LIMIT to narrow your query.
            </Banner>
          )}
          {result.columns.length === 0 ? (
            <Text as="p" tone="subdued">Query executed successfully. No rows returned.</Text>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: 320, overflowY: 'auto', border: '1px solid var(--p-color-border)', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--p-color-bg-surface-secondary)', position: 'sticky', top: 0 }}>
                    {result.columns.map((col) => (
                      <th key={col} style={{
                        padding: '8px 12px', textAlign: 'left', fontWeight: 600,
                        borderBottom: '1px solid var(--p-color-border)',
                        whiteSpace: 'nowrap'
                      }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--p-color-border-subdued)' }}
                      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'var(--p-color-bg-surface-secondary)'}
                      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = ''}
                    >
                      {row.map((cell, j) => (
                        <td key={j} style={{ padding: '6px 12px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cell === null
                            ? <span style={{ color: 'var(--p-color-text-disabled)', fontStyle: 'italic' }}>NULL</span>
                            : String(cell)
                          }
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal.Section>
      )}
    </Modal>
  )
}
