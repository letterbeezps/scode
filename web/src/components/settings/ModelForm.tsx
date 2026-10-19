/**
 * 新增 / 编辑模型的表单。
 *
 * 两种模式共用一个表单，差别全在后端的语义上：
 *
 * - 新增（editing = null）：name / provider / protocol / api_key 都必填。
 *   provider 已存在时，后端要求 protocol / base_url 与现有段一致，否则 400。
 * - 编辑（editing != null）：**name 和 provider 不可改**（要改请删后增），
 *   改的是协议 / 端点 / 密钥 / 展示名，且这四个字段在 toml 里属于整个
 *   供应商段 —— 保存后会波及同供应商下所有模型。
 *
 * api_key 在编辑模式下留空表示「不修改」，所以提交时整个字段不发，
 * 而不是发空串（后端会报「api_key 不能为空」）。
 */
import { useState } from 'react'
import { X } from 'lucide-react'
import type { AdminModel, ModelCreateInput, ModelProtocol, ModelUpdateInput } from '../../api/types'
import { cn } from '../../lib/cn'

const PROTOCOLS: ModelProtocol[] = ['anthropic', 'openai']

interface Props {
  /** null = 新增模式 */
  editing: AdminModel | null
  saving: boolean
  /** 新增提交 ModelCreateInput，编辑提交 ModelUpdateInput */
  onSubmit: (input: ModelCreateInput | ModelUpdateInput, isEdit: boolean) => void
  onCancel: () => void
}

export function ModelForm({ editing, saving, onSubmit, onCancel }: Props) {
  const isEdit = editing !== null

  const [name, setName] = useState(editing?.name ?? '')
  const [provider, setProvider] = useState(editing?.provider ?? '')
  const [protocol, setProtocol] = useState<ModelProtocol>(editing?.protocol ?? 'anthropic')
  const [baseUrl, setBaseUrl] = useState(editing?.base_url ?? '')
  const [displayName, setDisplayName] = useState(editing?.display_name ?? '')
  const [apiKey, setApiKey] = useState('')

  // 编辑模式下没填 api_key = 不改；base_url 允许显式清空，所以用 null 判断而非非空
  const dirty = isEdit
    ? apiKey !== '' ||
      protocol !== editing.protocol ||
      (baseUrl || '') !== (editing.base_url || '') ||
      displayName !== (editing.display_name ?? '')
    : name.trim() !== '' && provider.trim() !== '' && apiKey !== ''

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isEdit) {
      onSubmit(
        {
          protocol,
          // 空串在这里是「清掉这个字段」，不是「不动」
          base_url: baseUrl,
          display_name: displayName,
          // 留空就不发这个键，后端按「字段出现即写入」处理
          ...(apiKey ? { api_key: apiKey } : {}),
        },
        true,
      )
    } else {
      onSubmit(
        {
          name: name.trim(),
          provider: provider.trim(),
          protocol,
          base_url: baseUrl.trim(),
          api_key: apiKey,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
        },
        false,
      )
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border border-line bg-bg p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium text-fg">
          {isEdit ? `编辑 ${editing.id}` : '新增模型'}
        </h4>
        <button
          type="button"
          onClick={onCancel}
          aria-label="取消"
          className="rounded p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {isEdit && (
        <p className="mb-2 rounded border border-warn/30 bg-warn/10 px-2 py-1.5 text-[11px] leading-relaxed text-warn">
          模型名与供应商不可改，要换请删后增。协议 / 端点 / 密钥 / 展示名在 config.toml 里属于整个供应商段，
          保存后同供应商下其他模型也会一起变。
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="模型名 name" required>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={isEdit}
            placeholder="MiniMax-M3"
            className={inputClass(isEdit)}
          />
        </Field>

        <Field label="供应商 provider" required>
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={isEdit}
            placeholder="minimax"
            className={inputClass(isEdit)}
          />
        </Field>

        <Field label="协议 protocol" required>
          <select
            value={protocol}
            onChange={(e) => setProtocol(e.target.value as ModelProtocol)}
            className={inputClass(false)}
          >
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field label="展示名 display_name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="MiniMax"
            className={inputClass(false)}
          />
        </Field>

        <Field label="端点 base_url" hint="留空用协议官方端点">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.minimax.cn/anthropic"
            className={inputClass(false)}
          />
        </Field>

        <Field label="API Key" required={!isEdit} hint={isEdit ? '留空表示不修改' : undefined}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={isEdit ? '保持当前密钥' : 'sk-...'}
            autoComplete="off"
            className={inputClass(false)}
          />
        </Field>
      </div>

      {!isEdit && (
        <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
          模型 id 会是 <code className="font-mono">{provider.trim() || '<provider>'}:{name.trim() || '<name>'}</code>
          。供应商已存在时，协议与端点必须与现有段一致，否则请改用「编辑」。
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={saving || !dirty}
          className={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            saving || !dirty
              ? 'cursor-not-allowed bg-raised text-fg-muted'
              : 'bg-accent text-white hover:opacity-90',
          )}
        >
          {saving ? '保存中…' : isEdit ? '保存' : '新增'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-fg-muted transition-colors hover:bg-surface hover:text-fg"
        >
          取消
        </button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string
  hint?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-fg-muted">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
        {hint && <span className="ml-1.5 text-[10px] opacity-70">{hint}</span>}
      </span>
      {children}
    </label>
  )
}

function inputClass(disabled: boolean): string {
  return cn(
    'w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-fg',
    'focus:border-accent focus:outline-none',
    disabled && 'cursor-not-allowed opacity-50',
  )
}
