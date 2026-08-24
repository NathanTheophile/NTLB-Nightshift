import { useEffect } from 'react';

import type { LauncherConfiguration } from '@shared/contracts/ipc';

interface SettingsDialogProps {
  configuration: LauncherConfiguration;
  configuring: boolean;
  onClose: () => void;
  onConfigureIde: () => void;
}

export const SettingsDialog = ({ configuration, configuring, onClose, onConfigureIde }: SettingsDialogProps) => {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>NightShift</span>
            <h2 id="settings-title">Paramètres</h2>
          </div>
          <button type="button" aria-label="Fermer les paramètres" onClick={onClose}>×</button>
        </header>
        <div className="settings-section">
          <div className="settings-copy">
            <strong>IDE du projet</strong>
            <p>L’IDE configuré sera ouvert à la racine du projet actif.</p>
          </div>
          <div className="ide-setting-row">
            <span className={configuration.ideConfigured ? 'is-configured' : ''}>
              {configuration.ideDisplayName ?? 'Aucun IDE configuré'}
            </span>
            <button type="button" disabled={configuring} onClick={onConfigureIde}>
              {configuring ? 'Sélection…' : configuration.ideConfigured ? 'Remplacer…' : 'Choisir un IDE…'}
            </button>
          </div>
          <small>Le chemin de l’exécutable reste stocké localement par NightShift.</small>
        </div>
      </section>
    </div>
  );
};
