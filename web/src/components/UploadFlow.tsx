import { useCallback, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { api, type ImportDetail, type UploadResult } from '../api';

const ACCEPT = {
  'text/csv': ['.csv'],
  'text/tab-separated-values': ['.tsv', '.txt'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-excel.sheet.macroEnabled.12': ['.xlsm'],
};

interface Props {
  onDone: (imp: ImportDetail) => void;
  onCancel?: () => void;
}

export function UploadFlow({ onDone, onCancel }: Props) {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [sheet, setSheet] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [name, setName] = useState('');
  const [committing, setCommitting] = useState(false);

  const onDrop = useCallback(async (accepted: File[], rejected: FileRejection[]) => {
    setError(null);
    if (rejected.length) {
      setError(`${rejected[0].file.name}: ${rejected[0].errors[0]?.message ?? 'unsupported file type'}`);
      return;
    }
    const file = accepted[0];
    if (!file) return;
    setProgress(0);
    try {
      const result = await api.upload(file, setProgress);
      setUpload(result);
      setSheet(0);
      setHeaderRow(0);
      setName(file.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop, accept: ACCEPT, multiple: false });

  if (upload) {
    const s = upload.sheets[sheet];
    const preview = s.preview;
    const width = Math.max(0, ...preview.map((r) => r.length));
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <div className="text-sm font-semibold">Set up import</div>
          <div className="text-xs text-slate-500">{upload.filename}</div>
          <div className="flex-1" />
          <button className="btn" onClick={() => setUpload(null)}>
            Back
          </button>
          <button
            className="btn btn-primary"
            disabled={committing || !name.trim()}
            onClick={async () => {
              setCommitting(true);
              setError(null);
              try {
                const imp = await api.commit(upload.uploadId, { sheet: s.name, headerRow, name: name.trim() });
                onDone(imp);
              } catch (e) {
                setError((e as Error).message);
                setCommitting(false);
              }
            }}
          >
            {committing ? 'Importing…' : 'Import'}
          </button>
        </div>
        {error && <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex flex-wrap items-end gap-4 border-b border-slate-200 bg-white px-4 py-3">
          <label className="text-xs text-slate-600">
            Name
            <input className="input mt-1 block w-64" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {upload.kind === 'excel' && (
            <label className="text-xs text-slate-600">
              Sheet
              <select
                className="select mt-1 block"
                value={sheet}
                onChange={(e) => {
                  setSheet(Number(e.target.value));
                  setHeaderRow(0);
                }}
              >
                {upload.sheets.map((sh, i) => (
                  <option key={sh.name} value={i}>
                    {sh.name} ({sh.rowCount.toLocaleString()} rows)
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-xs text-slate-600">
            Header row
            <select className="select mt-1 block" value={headerRow} onChange={(e) => setHeaderRow(Number(e.target.value))}>
              {preview.map((_, i) => (
                <option key={i} value={i}>
                  Row {i + 1}
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-slate-500">
            {Math.max(0, s.rowCount - headerRow - 1).toLocaleString()} data rows will be imported. Click a row below to use it as the header.
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          <table className="min-w-full border-collapse text-xs">
            <tbody>
              {preview.map((row, ri) => (
                <tr
                  key={ri}
                  onClick={() => setHeaderRow(ri)}
                  className={`cursor-pointer ${
                    ri === headerRow ? 'bg-indigo-100 font-semibold' : ri < headerRow ? 'text-slate-400 line-through' : 'hover:bg-slate-100'
                  }`}
                >
                  <td className="border border-slate-200 bg-slate-50 px-2 py-1 text-right text-slate-400">{ri + 1}</td>
                  {Array.from({ length: width }, (_, ci) => (
                    <td key={ci} className="max-w-xs truncate border border-slate-200 px-2 py-1">
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div
        {...getRootProps()}
        className={`flex w-full max-w-xl cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-8 py-16 text-center transition ${
          isDragActive ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-white hover:border-slate-400'
        }`}
      >
        <input {...getInputProps()} />
        <div className="text-lg font-semibold">Drop a CSV or Excel file</div>
        <div className="mt-1 text-sm text-slate-500">or click to choose · .csv .tsv .xlsx .xls .xlsm</div>
        {progress !== null && (
          <div className="mt-6 w-64">
            <div className="h-2 overflow-hidden rounded bg-slate-200">
              <div className="h-full bg-indigo-600 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-1 text-xs text-slate-500">{progress < 100 ? `Uploading ${progress}%` : 'Parsing…'}</div>
          </div>
        )}
      </div>
      {error && <div className="mt-4 text-sm text-red-600">{error}</div>}
      {onCancel && (
        <button className="btn mt-6" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
