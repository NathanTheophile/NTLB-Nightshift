interface EmptyStateProps {
  eyebrow: string;
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const EmptyState = ({ eyebrow, title, detail, actionLabel, onAction }: EmptyStateProps) => (
  <div className="empty-state">
    <span>{eyebrow}</span>
    <h2>{title}</h2>
    <p>{detail}</p>
    {actionLabel && onAction && (
      <button className="primary-action" type="button" onClick={onAction}>
        {actionLabel}
      </button>
    )}
  </div>
);
