'use client';

import { parseDelimited, type DatePreference } from '@hishab/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import * as React from 'react';
import { Money } from '@/components/money';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import { ExportPanel } from './export-panel';
import { ImportHistory } from './history';
import { bnBytes, bnDate, bnNum, type ColumnRole } from './labels';
import { MappingStep } from './mapping-step';
import { Notice, QueryError, StepHeader } from './parts';
import {
  buildPreview,
  mappingFromRoles,
  mappingProblems,
  rolesFromMapping,
  toCommitRows,
  type DisplayRow,
} from './parse';
import {
  MAX_COMMIT_ROWS,
  MAX_IMPORT_BYTES,
  downloadCsv,
  invalidateAfterImport,
  minorToPlain,
  postCommit,
  postPreview,
  readFileAsText,
} from './transport';
import type { CommitResult, ImportPreview } from './types';

const PREVIEW_ROWS = 8;

interface LoadedFile {
  name: string;
  size: number;
  text: string;
}

/**
 * Import lives on one page, not in a wizard. All three steps stay visible, so
 * changing the mapping after reading the confirmation is one scroll rather than
 * a journey back through screens that have forgotten what you typed.
 *
 * The file never leaves the browser twice: it is uploaded once for the server's
 * reading of it — the column guess, the date convention, and crucially which
 * rows are already in the books — and everything after that is re-resolved here
 * with `@hishab/core`, the module the API itself runs.
 */
export default function ImportPage() {
  const queryClient = useQueryClient();

  const [file, setFile] = React.useState<LoadedFile | null>(null);
  const [preview, setPreview] = React.useState<ImportPreview | null>(null);
  const [roles, setRoles] = React.useState<ColumnRole[]>([]);
  const [datePreference, setDatePreference] = React.useState<DatePreference>('DMY');
  const [accountId, setAccountId] = React.useState('');
  const [result, setResult] = React.useState<CommitResult | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });

  const load = useMutation({
    mutationFn: async (chosen: File): Promise<{ loaded: LoadedFile; preview: ImportPreview }> => {
      const text = await readFileAsText(chosen);
      return {
        loaded: { name: chosen.name, size: chosen.size, text },
        preview: await postPreview(chosen.name, text),
      };
    },
    onSuccess: ({ loaded, preview: next }) => {
      haptic('success');
      setFile(loaded);
      setPreview(next);
      setRoles(rolesFromMapping(next.mapping, next.headers));
      setDatePreference(next.datePreference);
      setResult(null);
    },
    onError: (err) => {
      haptic('warn');
      setFileError(err instanceof ApiError ? err.message : 'ফাইলটি পড়া যায়নি');
    },
  });

  /**
   * The second pass the preview endpoint exists for. Changing the date
   * convention changes every date, and therefore every dedupe key, so the
   * server's list of "already in the books" has to be asked again — the
   * mapping the user has chosen is left exactly as it is.
   */
  const reparse = useMutation({
    mutationFn: (next: DatePreference) => {
      if (!file) throw new ApiError(0, 'আগে একটি ফাইল বেছে নিন');
      return postPreview(file.name, file.text, next);
    },
    onSuccess: (next) => setPreview(next),
    onError: () => haptic('warn'),
  });

  const commit = useMutation({
    mutationFn: () => {
      if (!preview || !built) throw new ApiError(0, 'আগে একটি ফাইল বেছে নিন');
      return postCommit({
        filename: preview.filename,
        fileHash: preview.fileHash,
        accountId,
        mapping,
        datePreference,
        rows: toCommitRows(built.rows),
      });
    },
    onSuccess: (committed) => {
      haptic('success');
      setResult(committed);
      invalidateAfterImport(queryClient);
    },
    onError: () => haptic('warn'),
  });

  const chooseFile = (chosen: File | null | undefined): void => {
    if (!chosen) return;
    setFileError(null);
    setResult(null);
    if (/\.xlsx?$/i.test(chosen.name)) {
      setFileError(
        'এক্সেলের .xlsx ফাইল সরাসরি পড়া যায় না। এক্সেল থেকে “CSV UTF-8” হিসেবে সেভ করে আবার দিন।',
      );
      return;
    }
    if (chosen.size > MAX_IMPORT_BYTES) {
      setFileError(
        `ফাইলটি বড় (${bnBytes(chosen.size)})। ${bnBytes(MAX_IMPORT_BYTES)}-এর কম ফাইল দিন, অথবা ফাইলটি ভাগ করে নিন।`,
      );
      return;
    }
    load.mutate(chosen);
  };

  const headers = preview?.headers ?? [];

  // Core does the reading — the same module the API runs, so this preview is
  // the server's answer and not our impression of it.
  const grid = React.useMemo(() => (file ? parseDelimited(file.text) : []), [file]);
  const mapping = React.useMemo(() => mappingFromRoles(roles, headers), [roles, headers]);

  /** The dedupe keys the server has already told us are in the books. */
  const knownDuplicateKeys = React.useMemo(
    () => new Set((preview?.sample ?? []).filter((row) => row.isDuplicate).map((r) => r.dedupeKey)),
    [preview],
  );

  const built = React.useMemo(
    () => (preview ? buildPreview(grid, mapping, datePreference, knownDuplicateKeys) : null),
    [preview, grid, mapping, datePreference, knownDuplicateKeys],
  );

  const mappingState = React.useMemo(() => mappingProblems(roles, mapping), [roles, mapping]);

  /**
   * True while the server's own counts still describe what is on screen. Once
   * a column is changed here, only its duplicate check is stale — it will run
   * again at commit, and its answer is the one that counts.
   */
  const serverFresh = React.useMemo(() => {
    if (!preview) return false;
    if (preview.datePreference !== datePreference) return false;
    const asSent = rolesFromMapping(preview.mapping, preview.headers);
    return roles.length === asSent.length && roles.every((role, i) => role === asSent[i]);
  }, [preview, roles, datePreference]);

  const counts =
    serverFresh && preview
      ? {
          importable: preview.importableRows,
          duplicates: preview.duplicateRows,
          broken: preview.errorRows,
        }
      : (built?.counts ?? { importable: 0, duplicates: 0, broken: 0 });

  const netMinor = React.useMemo(
    () =>
      (built?.rows ?? []).reduce(
        (total, row) =>
          row.isDuplicate
            ? total
            : total + (row.direction === 'OUT' ? -row.amountMinor : row.amountMinor),
        0,
      ),
    [built],
  );

  const offered = built?.rows.length ?? 0;
  const tooManyRows = offered > MAX_COMMIT_ROWS;
  const overLimit =
    preview?.limit.remaining !== null &&
    preview !== null &&
    preview.limit.remaining < counts.importable;

  const blocked =
    mappingState.blocking.length > 0 ||
    accountId === '' ||
    offered === 0 ||
    tooManyRows ||
    commit.isPending ||
    reparse.isPending;

  const reset = (): void => {
    setFile(null);
    setPreview(null);
    setRoles([]);
    setResult(null);
    setFileError(null);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-ink hidden text-xl font-semibold sm:text-2xl md:block">
          ইমপোর্ট ও এক্সপোর্ট
        </h1>
        <p className="text-ink-muted text-sm">
          ব্যাংক বা মোবাইল ওয়ালেটের স্টেটমেন্ট থেকে লেনদেন তুলে আনুন — কোন কলাম কী, সেটা আপনি ঠিক
          করবেন।
        </p>
      </header>

      {/* ---- Step 1: the file ------------------------------------------- */}
      <section className="rounded-card border-rule bg-surface flex flex-col gap-3 border p-4">
        <StepHeader
          step="১"
          title="ফাইল বেছে নিন"
          hint="সিএসভি বা ট্যাব দিয়ে আলাদা করা টেক্সট ফাইল"
          done={file !== null}
        />

        <FileDrop onFile={chooseFile} busy={load.isPending} />

        {fileError ? <Notice tone="bad">{fileError}</Notice> : null}

        {load.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : file && preview ? (
          <div className="bg-greenbar flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md p-3 text-sm">
            <span className="text-ink flex min-w-0 items-center gap-1.5 font-medium">
              <FileSpreadsheet className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{preview.filename}</span>
            </span>
            <span className="text-ink-muted text-xs">{bnBytes(file.size)}</span>
            <span className="text-ink-muted text-xs">{bnNum(preview.totalRows)}টি সারি</span>
            <button
              type="button"
              onClick={reset}
              className="press text-income ml-auto min-h-11 text-xs underline"
            >
              অন্য ফাইল দিন
            </button>
          </div>
        ) : null}

        {/* The same bytes have been through here before. Worth saying loudly:
            this is the one thing that silently doubles somebody's books. */}
        {preview?.alreadyImported ? (
          <Notice tone="warn">
            এই একই ফাইল {bnDate(preview.alreadyImported.createdAt)} তারিখে ইমপোর্ট করা হয়েছিল (“
            {preview.alreadyImported.filename}”)। আবার করলে যে সারিগুলো আগেই আছে সেগুলো বাদ যাবে।
          </Notice>
        ) : null}

        {preview && preview.errors.length > 0 ? (
          <details className="border-rule rounded-md border p-3">
            <summary className="text-brass min-h-11 cursor-pointer text-sm">
              {bnNum(preview.errors.length)}টি সারি সার্ভার পড়তে পারেনি
            </summary>
            <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-xs">
              {preview.errors.map((problem, i) => (
                <li key={`${problem.lineNumber}-${i}`}>
                  লাইন {bnNum(problem.lineNumber)}: {problem.message}
                </li>
              ))}
              {preview.errorsTruncated ? <li>…তালিকাটি এখানেই থামানো হয়েছে।</li> : null}
            </ul>
          </details>
        ) : null}
      </section>

      {/* ---- Step 2: the mapping ---------------------------------------- */}
      {preview ? (
        <section className="rounded-card border-rule bg-surface flex flex-col gap-4 border p-4">
          <StepHeader
            step="২"
            title="কলাম মেলান"
            hint="প্রতিটি কলাম কী, আর তারিখ কোন নিয়মে লেখা"
            done={mappingState.blocking.length === 0 && accountId !== ''}
          />

          {accounts.isError ? (
            <QueryError
              message="অ্যাকাউন্টের তালিকা আনা যায়নি।"
              onRetry={() => void accounts.refetch()}
            />
          ) : (
            <MappingStep
              headers={headers}
              roles={roles}
              onRoleChange={(index, role) =>
                setRoles((current) => current.map((r, i) => (i === index ? role : r)))
              }
              sampleCells={grid[1] ?? []}
              datePreference={datePreference}
              onDatePreferenceChange={(next) => {
                setDatePreference(next);
                reparse.mutate(next);
              }}
              dateConfident={preview.datePreferenceConfident}
              reparsing={reparse.isPending}
              accounts={accounts.data ?? []}
              accountId={accountId}
              onAccountChange={setAccountId}
              preview={(built?.display ?? []).slice(0, PREVIEW_ROWS)}
              problems={mappingState.blocking}
              warnings={mappingState.warnings}
            />
          )}
        </section>
      ) : null}

      {/* ---- Step 3: confirm -------------------------------------------- */}
      {preview ? (
        <section className="rounded-card border-rule bg-surface flex flex-col gap-4 border p-4">
          <StepHeader step="৩" title="মিলিয়ে নিয়ে যোগ করুন" done={result !== null} />

          <dl className="grid grid-cols-3 gap-2">
            <Count label="যোগ হবে" value={counts.importable} tone="text-income" />
            <Count label="আগেই আছে, বাদ যাবে" value={counts.duplicates} tone="text-brass" />
            <Count label="পড়া যায়নি, বাদ যাবে" value={counts.broken} tone="text-expense" />
          </dl>

          <div className="border-rule flex items-baseline justify-between gap-2 border-t pt-3">
            <span className="text-ink-muted text-sm">যোগ হওয়া সারিগুলোর মোট</span>
            <Money minor={netMinor} colored signed className="text-base font-semibold" />
          </div>

          {!serverFresh ? (
            <p className="text-ink-muted text-xs">
              আপনি কলাম বা তারিখের ধরন বদলেছেন, তাই উপরের হিসাব এই ব্রাউজারের। কোন সারিগুলো আগে
              থেকেই খাতায় আছে, সেটা যোগ করার সময় সার্ভার আবার মিলিয়ে দেখবে।
            </p>
          ) : null}

          {tooManyRows ? (
            <Notice tone="bad">
              একবারে সর্বোচ্চ {bnNum(MAX_COMMIT_ROWS)}টি সারি যোগ করা যায়, এখানে {bnNum(offered)}টি
              আছে। ফাইলটি ভাগ করে নিন।
            </Notice>
          ) : null}

          {overLimit && preview.limit.remaining !== null ? (
            <Notice tone="warn">
              আপনার প্ল্যানে এই মাসে আর {bnNum(preview.limit.remaining)}টি লেনদেন যোগ করা যাবে, তাই
              পুরো ফাইলটি হয়তো আঁটবে না।
            </Notice>
          ) : null}

          {counts.duplicates + counts.broken > 0 && built ? (
            <button
              type="button"
              onClick={() => downloadSkipped(preview.filename, built.display)}
              className="press text-income min-h-11 self-start text-sm underline"
            >
              বাদ পড়া সারিগুলোর তালিকা নামান
            </button>
          ) : null}

          {accountId === '' ? (
            <Notice tone="warn">উপরে কোন অ্যাকাউন্টে যাবে সেটা বেছে নিন।</Notice>
          ) : null}

          {commit.isError ? (
            <Notice tone="bad">
              {commit.error instanceof ApiError ? commit.error.message : 'ইমপোর্ট করা যায়নি'}
            </Notice>
          ) : null}

          {result ? (
            <div className="bg-income/10 flex flex-col gap-1 rounded-md p-3" role="status">
              <p className="text-income flex items-center gap-1.5 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                ইমপোর্ট শেষ
              </p>
              <p className="text-ink text-sm">
                {bnNum(result.importedCount)}টি লেনদেন যোগ হয়েছে, {bnNum(result.skippedCount)}টি
                বাদ পড়েছে।
              </p>
              {result.skipped.length > 0 ? (
                <details className="mt-1">
                  <summary className="text-ink-muted min-h-11 cursor-pointer text-xs">
                    কোনগুলো বাদ পড়ল দেখুন
                  </summary>
                  <ul className="text-ink-muted mt-1 flex flex-col gap-1 text-xs">
                    {result.skipped.map((row, i) => (
                      <li key={`${row.lineNumber}-${i}`}>
                        লাইন {bnNum(row.lineNumber)} ({bnDate(row.date)}): {row.reason}
                      </li>
                    ))}
                    {result.skippedTruncated ? <li>…তালিকাটি এখানেই থামানো হয়েছে।</li> : null}
                  </ul>
                </details>
              ) : null}
              <p className="text-ink-muted text-xs">
                ভুল হয়ে থাকলে নিচের তালিকা থেকে এক ট্যাপে পুরোটা ফিরিয়ে নিতে পারবেন।
              </p>
              <Button variant="outline" size="sm" className="mt-2 self-start" onClick={reset}>
                আরেকটি ফাইল ইমপোর্ট করুন
              </Button>
            </div>
          ) : (
            <Button size="block" disabled={blocked} onClick={() => commit.mutate()}>
              <Upload className="h-4 w-4" aria-hidden />
              {commit.isPending
                ? 'যোগ করা হচ্ছে…'
                : `${bnNum(counts.importable)}টি লেনদেন যোগ করুন`}
            </Button>
          )}
        </section>
      ) : null}

      <ImportHistory />
      <ExportPanel />
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted truncate text-xs">{label}</dt>
      <dd className={cn('text-lg font-semibold', tone)}>{bnNum(value)}</dd>
    </div>
  );
}

/** The rows that will not make it, with the reason, as a file they can fix and re-upload. */
function downloadSkipped(filename: string, rows: readonly DisplayRow[]): void {
  haptic('tap');
  const body = rows
    .filter((row) => row.problem !== null || row.duplicate)
    .map((row) => [
      String(row.lineNumber),
      row.date ?? '',
      row.description,
      row.reference ?? '',
      row.amountMinor === null ? '' : minorToPlain(row.amountMinor),
      row.problem ?? 'আগেই খাতায় আছে',
    ]);

  downloadCsv(`${filename.replace(/\.[^.]+$/, '')}-bad-para-sari.csv`, [
    ['লাইন', 'তারিখ', 'বিবরণ', 'রেফারেন্স', 'টাকার অঙ্ক', 'কারণ'],
    ...body,
  ]);
}

/** Drag a file onto it, or tap it. Both do the same thing. */
function FileDrop({ onFile, busy }: { onFile: (file: File | null) => void; busy: boolean }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        haptic('select');
        onFile(e.dataTransfer.files?.[0] ?? null);
      }}
      className={cn(
        'rounded-card flex flex-col items-center gap-2 border border-dashed p-6 text-center transition-colors',
        over ? 'border-income bg-greenbar' : 'border-rule',
      )}
    >
      <Upload className="text-ink-muted h-6 w-6" aria-hidden />
      <p className="text-ink text-sm">ফাইলটি এখানে টেনে আনুন</p>
      <p className="text-ink-muted text-xs">অথবা</p>
      <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'পড়া হচ্ছে…' : 'ফাইল বেছে নিন'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
        className="sr-only"
        aria-label="ইমপোর্ট করার ফাইল"
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          // Let the same file be chosen twice in a row.
          e.target.value = '';
        }}
      />
    </div>
  );
}
