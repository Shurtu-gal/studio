import { AbstractService } from './abstract.service';

import { DiagnosticSeverity } from '@asyncapi/parser/cjs';
import { KeyMod, KeyCode, Range, MarkerSeverity } from 'monaco-editor/esm/vs/editor/editor.api';
import toast from 'react-hot-toast';
import fileDownload from 'js-file-download';

import { debounce, isDeepEqual } from '../helpers';
import { appState, filesState, settingsState } from '../state';

import type * as monacoAPI from 'monaco-editor/esm/vs/editor/editor.api';
import type { Diagnostic } from '@asyncapi/parser/cjs';
import type { ConvertVersion } from '@asyncapi/converter';
import type { File } from '../state/files.state';
import type { EditorTab } from '../state/panels.state';
import type { Document } from '../state/documents.state';
import type { SettingsState } from '../state/settings.state';

export interface UpdateState {
  content: string;
  updateModel?: boolean;
  sendToServer?: boolean;
  file?: Partial<File>;
} 

export class EditorService extends AbstractService {
  private isCreated: boolean = false;
  private decorations: Map<string, string[]> = new Map();
  private instance: monacoAPI.editor.IStandaloneCodeEditor | undefined;
  private models: Map<string, monacoAPI.editor.ITextModel | null> = new Map();
  private viewStates: Map<string, monacoAPI.editor.ICodeEditorViewState | null> = new Map();

  override onInit() {
    this.subscribeToFiles();
    this.subscribeToPanels();
    this.subcribeToDocuments();
  }

  get editor(): monacoAPI.editor.IStandaloneCodeEditor {
    return this.instance as monacoAPI.editor.IStandaloneCodeEditor;
  }

  get value(): string {
    return this.editor?.getModel()?.getValue() as string;
  }

  async onSetupEditor(elementRef: HTMLElement) {
    if (this.isCreated) {
      return;
    }
    this.isCreated = true;
    
    // // apply save command
    // this.editor.addCommand(
    //   KeyMod.CtrlCmd | KeyCode.KeyS,
    //   () => this.saveToLocalStorage(),
    // );
    // this.editor.onDidChangeModelContent(this.onChangeContent.bind(this));
  
    this.createEditor(elementRef);
    this.configureEditor();
    appState.setState({ initialized: true });
  }

  updateState({
    content,
    updateModel = false,
    sendToServer = true,
    file = {},
  }: UpdateState) {
    const currentContent = filesState.getState().files['asyncapi']?.content;
    if (currentContent === content || typeof content !== 'string') {
      return;
    }

    const language = file.language || this.svcs.formatSvc.retrieveLangauge(content);
    if (!language) {
      return;
    }

    if (sendToServer) {
      this.svcs.socketClientSvc.send('file:update', { code: content });
    }

    if (updateModel && this.editor) {
      const model = this.editor.getModel();
      if (model) {
        model.setValue(content);
      }
    }

    this.svcs.filesSvc.updateFile('asyncapi', {
      language,
      content,
      modified: this.getFromLocalStorage() !== content,
      ...file,
    });
  }

  async convertSpec(version?: ConvertVersion | string) {
    const converted = await this.svcs.converterSvc.convert(this.value, version as ConvertVersion);
    this.updateState({ content: converted, updateModel: true });
  }

  async importFromURL(url: string): Promise<void> {
    if (url) {
      return fetch(url)
        .then(res => res.text())
        .then(async text => {
          this.updateState({ 
            content: text, 
            updateModel: true, 
            file: { 
              source: url, 
              from: 'url' 
            },
          });
        })
        .catch(err => {
          console.error(err);
          throw err;
        });
    }
  }

  async importFile(files: FileList | null) {
    if (files === null || files?.length !== 1) {
      return;
    }
    const file = files.item(0);
    if (!file) {
      return;
    }

    const fileReader = new FileReader();
    fileReader.onload = fileLoadedEvent => {
      const content = fileLoadedEvent.target?.result;
      this.updateState({ content: String(content), updateModel: true });
    };
    fileReader.readAsText(file, 'UTF-8');
  }

  async importBase64(content: string) {
    try {
      const decoded = this.svcs.formatSvc.decodeBase64(content);
      this.updateState({ 
        content: String(decoded), 
        updateModel: true, 
        file: { 
          from: 'base64', 
          source: undefined, 
        },
      });
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async convertToYaml() {
    try {
      const yamlContent = this.svcs.formatSvc.convertToYaml(this.value);
      if (yamlContent) {
        this.updateState({ 
          content: yamlContent, 
          updateModel: true, 
          file: {
            language: 'yaml',
          }
        });
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async convertToJSON() {
    try {
      const jsonContent = this.svcs.formatSvc.convertToJSON(this.value);
      if (jsonContent) {
        this.updateState({ 
          content: jsonContent, 
          updateModel: true, 
          file: {
            language: 'json',
          }
        });
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async saveAsYaml() {
    try {
      const yamlContent = this.svcs.formatSvc.convertToYaml(this.value);
      if (yamlContent) {
        this.downloadFile(yamlContent, `${this.fileName}.yaml`);
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  async saveAsJSON() {
    try {
      const jsonContent = this.svcs.formatSvc.convertToJSON(this.value);
      if (jsonContent) {
        this.downloadFile(jsonContent, `${this.fileName}.json`);
      }
    } catch (err) {
      console.error(err);
      throw err;
    }
  }

  saveToLocalStorage(editorValue?: string, notify = true) {
    editorValue = editorValue || this.value;
    localStorage.setItem('document', editorValue);

    this.svcs.filesSvc.updateFile('asyncapi', {
      from: 'storage',
      source: undefined,
      modified: false,
    });

    if (notify) {
      if (settingsState.getState().editor.autoSaving) {
        toast.success(
          <div>
            <span className="block text-bold">
              Studio is currently saving your work automatically 💪
            </span>
          </div>,
        );
      } else {
        toast.success(
          <div>
            <span className="block text-bold">
              Document succesfully saved to the local storage!
            </span>
          </div>,
        );
      }
    }
  }

  getFromLocalStorage() {
    return localStorage.getItem('document');
  }

  private createEditor(elementRef: HTMLElement) {
    this.instance = this.svcs.monacoSvc.monaco.editor.create(elementRef, {
      automaticLayout: true,
      theme: 'asyncapi-theme',
      wordWrap: 'on',
      smoothScrolling: true,
      glyphMargin: true,
    });
  }

  private configureEditor() {
    let unsubscribe = this.editor.onDidChangeModelContent(
      this.onChangeContent(this.svcs.settingsSvc.get()).bind(this),
    );

    this.svcs.eventsSvc.on('settings.update', (settings, prevSettings) => {
      if (isDeepEqual(settings.governance, prevSettings.governance)) {
        return;
      }

      if (unsubscribe) {
        unsubscribe.dispose();
        unsubscribe = this.editor.onDidChangeModelContent(
          this.onChangeContent(this.svcs.settingsSvc.get()).bind(this),
        );
      }
    });
  }

  private getModel(uri: string) {
    return this.models.get(uri) || this.createModel(uri);
  }

  private getCurrentModel() {
    return this.editor?.getModel();
  }

  private createModel(uri: string, file?: File) {
    if (this.models.has(uri)) {
      return;
    }

    const monaco = this.svcs.monacoSvc.monaco;
    file = file || this.svcs.filesSvc.getFile(uri);
    if (!file) {
      return;
    }

    const modelUri = monaco.Uri.parse(file.uri);
    const model = monaco.editor.createModel(file.content, file.language, modelUri);
    this.models.set(uri, model);

    return model;
  }

  private removeModel(uri: string) {
    const model = this.models.get(uri);
    if (!model) {
      return;
    }

    model.dispose();
    return this.models.delete(uri);
  }

  private onChangeContent(settings: SettingsState) {
    const editorState = settings.editor;
    return debounce((e: monacoAPI.editor.IModelContentChangedEvent) => {
      const model = this.getCurrentModel();
      if (model) {
        const content = model.getValue();
        // this.updateState({ content });
        // if (editorState.autoSaving) {
        //   this.saveToLocalStorage(content, false);
        // }
        console.log(model.uri.toString());
        this.svcs.parserSvc.parse(model.uri.toString(), content);
      } 
    }, editorState.savingDelay);
  }

  private onChangeTab(newTab: EditorTab) {
    const oldModel = this.getCurrentModel();
    if (oldModel) {
      const viewState = this.editor.saveViewState();
      const uri = oldModel.uri.toString();
      this.viewStates.set(uri, viewState);
    }

    const model = this.getModel(newTab.uri);
    if (model) {
      this.editor.setModel(model)
      this.editor.focus();

      const uri = model.uri.toString();
      const restoredViewState = this.viewStates.get(uri);
      if (restoredViewState) {
        this.editor.restoreViewState(restoredViewState);
      }
    }
  }

  private applyMarkersAndDecorations(document: Document) {
    const { uri, diagnostics } = document;
    const model = this.getModel(uri);
    if (!model || !this.editor) {
      return;
    }

    const { markers, decorations } = this.createMarkersAndDecorations(diagnostics.filtered);
    this.svcs.monacoSvc.monaco.editor.setModelMarkers(model, uri, markers);
    let oldDecorations = this.decorations.get(uri) || [];
    console.log(oldDecorations, decorations);
    oldDecorations = this.editor.deltaDecorations(oldDecorations, decorations);
    this.decorations.set(uri, oldDecorations);
  }

  private removeMarkersAndDecorations(document: Document) {
    const { uri } = document;
    const model = this.getModel(uri);
    if (!model || !this.editor) {
      return;
    }

    this.svcs.monacoSvc.monaco.editor.setModelMarkers(model, uri, []);
    let oldDecorations = this.decorations.get(uri) || [];
    oldDecorations = this.editor.deltaDecorations(oldDecorations, []);
    this.decorations.set(uri, oldDecorations);
  }

  createMarkersAndDecorations(diagnostics: Diagnostic[] = []) {
    const newDecorations: monacoAPI.editor.IModelDecoration[] = [];
    const newMarkers: monacoAPI.editor.IMarkerData[] = [];

    diagnostics.forEach((diagnostic, idx) => {
      const { message, range, severity } = diagnostic;

      if (severity !== DiagnosticSeverity.Error) {
        const className = this.getSeverityClassName(severity);
        newDecorations.push({
          id: `${className}-${idx}`,
          ownerId: 0,
          range: new Range(
            range.start.line + 1, 
            range.start.character + 1,
            range.end.line + 1,
            range.end.character + 1
          ),
          options: {
            glyphMarginClassName: this.getSeverityClassName(severity),
            glyphMarginHoverMessage: { value: message },
          },
        });
        return;
      }
  
      newMarkers.push({
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1,
        severity: this.getSeverity(severity),
        message,
      });
    });

    return { decorations: newDecorations, markers: newMarkers };
  }

  private getSeverity(severity: DiagnosticSeverity): monacoAPI.MarkerSeverity {
    switch (severity) {
    case DiagnosticSeverity.Error: return MarkerSeverity.Error;
    case DiagnosticSeverity.Warning: return MarkerSeverity.Warning;
    case DiagnosticSeverity.Information: return MarkerSeverity.Info;
    case DiagnosticSeverity.Hint: return MarkerSeverity.Hint;
    default: return MarkerSeverity.Error;
    }
  }

  private getSeverityClassName(severity: DiagnosticSeverity): string {
    switch (severity) {
    case DiagnosticSeverity.Warning: return 'diagnostic-warning';
    case DiagnosticSeverity.Information: return 'diagnostic-information';
    case DiagnosticSeverity.Hint: return 'diagnostic-hint';
    default: return 'diagnostic-warning';
    }
  }

  private fileName = 'asyncapi';
  private downloadFile(content: string, fileName: string) {
    return fileDownload(content, fileName);
  }

  private subscribeToFiles() {
    this.svcs.eventsSvc.on('fs.file.remove', file => {
      this.removeModel(file.uri);
    });
  }

  private subscribeToPanels() {
    this.svcs.eventsSvc.on('panels.panel.set-active-tab', panel => {
      const tab = this.svcs.panelsSvc.getTab(panel.id, panel.activeTab);
      if (tab && tab.type === 'editor') {
        this.onChangeTab(tab);
      }
    });
  }

  private subcribeToDocuments() {
    this.svcs.eventsSvc.on('documents.document.create', document => {
      this.applyMarkersAndDecorations(document);
    });

    this.svcs.eventsSvc.on('documents.document.update', document => {
      this.applyMarkersAndDecorations(document);
    });

    this.svcs.eventsSvc.on('documents.document.remove', document => {
      this.removeMarkersAndDecorations(document);
    });
  }
}
