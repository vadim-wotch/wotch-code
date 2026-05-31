import type { PendingApproval } from '../../../shared/protocol'

interface Props {
  tabId: string
  request: PendingApproval | undefined
}

export default function ApprovalModal({ tabId, request }: Props): React.JSX.Element | null {
  if (!request) return null
  const respond = (decision: 'allow' | 'deny'): void => {
    window.api.approve(tabId, request.id, decision)
  }
  return (
    <div className="modal-backdrop">
      <div className="modal modal--approval">
        <div className="approval__title">{request.title ?? `Allow ${request.toolName}?`}</div>
        {request.description && <div className="approval__desc">{request.description}</div>}
        {request.blockedPath && (
          <div className="approval__path">
            <span className="approval__label">path</span>
            <code>{request.blockedPath}</code>
          </div>
        )}
        <div className="approval__input">
          <div className="approval__label">{request.toolName}</div>
          <pre>{JSON.stringify(request.input, null, 2)}</pre>
        </div>
        {request.decisionReason && <div className="approval__reason">{request.decisionReason}</div>}
        <div className="modal__actions">
          <button className="btn" onClick={() => respond('deny')}>
            Deny
          </button>
          <button className="btn btn--primary" onClick={() => respond('allow')}>
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
