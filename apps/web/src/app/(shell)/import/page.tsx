'use client';

import type { DatePreference } from '@hishab/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileSpreadsheet, Upload } from '@/components/icons';
import * as React from 'react';
import { Skeleton } from '@/components/skeleton';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { ApiError, endpoints } from '@/lib/api';
import { haptic } from '@/lib/haptics';
import { t } from '@/lib/t';
import { cn } from '@/lib/utils';
import { ExportPanel } from './export-panel';
import { ImportHistory } from './history';
import { bnBytes, bnDate, bnNum, type ColumnRole } from './labels';
import { MappingStep } from './mapping-step';
import { Notice, QueryError, StepHeader } from './parts';
import { mappingFromRoles, mappingProblems, rolesFromMapping, type DisplayRow } from './parse';
import { buildReview, probesFrom, toApprovedRows, type RowDecision } from './review';
import { ReviewStep } from './review-step';
import type { DuplicateReport, StatementPreview } from './statement-types';
import {
  MAX_COMMIT_ROWS,
  MAX_STATEMENT_BYTES,
  downloadCsv,
  invalidateAfterImport,
  minorToPlain,
  postCommit,
  postDuplicateCheck,
  postStatement,
  readFileAsBytes,
} from './transport';
import type { CommitResult } from './types';

const MAPPING_SAMPLE_ROWS = 8;

interface LoadedFile {
  name: string;
  size: number;
  bytes: ArrayBuffer;
}

/**
 * Import lives on one page, not in a wizard. All three steps stay visible, so
 * changing a column after reading the review is one scroll rather than a
 * journey back through screens that have forgotten what you typed.
 *
 * ## What arrives, and what happens to it
 *
 * A statement turns up as a CSV, an Excel workbook or a PDF depending on which
 * bank it came from, and the file is sent to the server exactly as it is. The
 * server decides the format from its first bytes and answers with **a grid of
 * strings** — the same shape a CSV has always had — plus the mapping it
 * guessed and, crucially, which rows look like transactions the books already
 * hold.
 *
 * Everything after that is re-resolved here with `@hishab/core`, the module the
 * API itself runs, so changing a column re-parses the whole file live and the
 * preview is the server's answer rather than an impression of it.
 *
 * ## Why the last step is a list and not a button
 *
 * Because in Bangladesh a transaction reaches these books by two routes: the
 * bank sends an SMS and it is recorded within the minute, or it sends nothing
 * and only the statement knows. Every statement is therefore part already-here
 * and part missing, and no button can tell the halves apart. So each row is
 * approved on its own, and the rows that might already be here say so — beside
 * the entry they matched, so it can be checked. The app never skips a row and
 * never merges one; it raises the question and the person answers it.
 */
export default function ImportPage() {
  const queryClient = useQueryClient();

  const [file, setFile] = React.useState<LoadedFile | null>(null);
  const [preview, setPreview] = React.useState<StatementPreview | null>(null);
  const [duplicates, setDuplicates] = React.useState<DuplicateReport | null>(null);
  const [roles, setRoles] = React.useState<ColumnRole[]>([]);
  const [datePreference, setDatePreference] = React.useState<DatePreference>('DMY');
  const [accountId, setAccountId] = React.useState('');
  const [decisions, setDecisions] = React.useState<Map<number, RowDecision>>(new Map());
  const [result, setResult] = React.useState<CommitResult | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: endpoints.accounts });
  const categories = useQuery({ queryKey: ['categories'], queryFn: endpoints.categories });

  const applyPreview = (loaded: LoadedFile, next: StatementPreview): void => {
    setFile(loaded);
    setPreview(next);
    setDuplicates(next.duplicates);
    setRoles(rolesFromMapping(next.mapping, next.headers));
    setDatePreference(next.datePreference);
    /* A new reading of the file is a new set of rows. Keeping decisions across
       it would attach somebody's approval to a row that is no longer the one
       they approved — the line numbers survive a re-read, the contents do
       not. */
    setDecisions(new Map());
    setResult(null);
  };

  const load = useMutation({
    mutationFn: async (
      chosen: File,
    ): Promise<{ loaded: LoadedFile; preview: StatementPreview }> => {
      const bytes = await readFileAsBytes(chosen);
      return {
        loaded: { name: chosen.name, size: chosen.size, bytes },
        preview: await postStatement(chosen.name, bytes, {
          accountId: accountId || undefined,
        }),
      };
    },
    onSuccess: ({ loaded, preview: next }) => {
      haptic('success');
      applyPreview(loaded, next);
    },
    onError: (err) => {
      haptic('warn');
      setFileError(err instanceof ApiError ? err.message : 'ফাইলটি পড়া যায়নি');
    },
  });

  /** Another tab of the same workbook, without re-reading the file locally. */
  const switchSheet = useMutation({
    mutationFn: (sheet: string) => {
      if (!file) throw new ApiError(0, 'আগে একটি ফাইল বেছে নিন');
      return postStatement(file.name, file.bytes, {
        accountId: accountId || undefined,
        datePreference,
        sheet,
      });
    },
    onSuccess: (next) => {
      if (file) applyPreview(file, next);
    },
    onError: () => haptic('warn'),
  });

  const headers = preview?.headers ?? [];
  const grid = preview?.grid ?? [];
  const mapping = React.useMemo(() => mappingFromRoles(roles, headers), [roles, headers]);

  const review = React.useMemo(
    () =>
      preview
        ? buildReview(
            grid,
            mapping,
            datePreference,
            duplicates ?? { scope: 'ALL_ACCOUNTS', accountId: null, rows: [], flaggedRows: 0 },
            categories.data ?? [],
            decisions,
          )
        : null,
    [preview, grid, mapping, datePreference, duplicates, categories.data, decisions],
  );

  const mappingState = React.useMemo(() => mappingProblems(roles, mapping), [roles, mapping]);

  /* --- keeping the duplicate check honest --------------------------------
   *
   * The answer depends on three things the user can change after the upload:
   * the account, the column mapping, and the date convention. Any of them
   * moves a row's date or its amount, and a stale warning is worse than none —
   * it would be pointing at an entry that no longer matches.
   *
   * So the rows the check was last run for are remembered as a signature, and
   * whenever the current rows disagree with it the check is asked again. It is
   * one small POST of dates and amounts; the file does not go up the wire
   * twice. */
  const probes = React.useMemo(() => (review ? probesFrom(review.rows) : []), [review]);
  const signature = React.useMemo(
    () =>
      `${accountId}|${probes.map((p) => `${p.lineNumber}:${p.date}:${p.amountMinor}`).join(',')}`,
    [accountId, probes],
  );
  const checkedFor = React.useRef<string | null>(null);

  const recheck = useMutation({
    mutationFn: (input: { accountId: string | null; rows: typeof probes }) =>
      postDuplicateCheck(input),
    onSuccess: (report) => setDuplicates(report),
  });
  const recheckMutate = recheck.mutate;

  React.useEffect(() => {
    if (!preview) {
      checkedFor.current = null;
      return;
    }
    /* The upload's own answer already covers the state it was made in, so the
       first pass is not repeated. */
    if (checkedFor.current === null) {
      checkedFor.current = signature;
      return;
    }
    if (checkedFor.current === signature) return;
    checkedFor.current = signature;
    recheckMutate({ accountId: accountId || null, rows: probes });
  }, [preview, signature, accountId, probes, recheckMutate]);

  const commit = useMutation({
    mutationFn: () => {
      if (!preview || !review) throw new ApiError(0, 'আগে একটি ফাইল বেছে নিন');
      return postCommit({
        filename: preview.filename,
        fileHash: preview.fileHash,
        accountId,
        mapping,
        datePreference,
        rows: toApprovedRows(review.rows),
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
    if (chosen.size > MAX_STATEMENT_BYTES) {
      /* Two whole sentences with the figures between them, rather than one
         sentence with the figures spliced in. A translation cannot keep a
         clause order it was never given. */
      setFileError(
        `${t('import.file.tooBig', 'ফাইলটি খুব বড়।')} ` +
          `${bnBytes(chosen.size)} / ${bnBytes(MAX_STATEMENT_BYTES)}. ` +
          `${t(
            'import.file.tooBigHint',
            'ফাইলটি ভাগ করে নিন, অথবা ব্যাংক থেকে কম সময়ের স্টেটমেন্ট নামান।',
          )}`,
      );
      return;
    }
    load.mutate(chosen);
  };

  const setDecision = (lineNumber: number, patch: RowDecision): void => {
    setDecisions((current) => {
      const next = new Map(current);
      next.set(lineNumber, { ...current.get(lineNumber), ...patch });
      return next;
    });
  };

  /** Tick everything the app has no question about, and nothing it does. */
  const tickClean = (): void => {
    haptic('select');
    setDecisions((current) => {
      const next = new Map(current);
      for (const row of review?.rows ?? []) {
        if (row.problem !== null || row.matches.length > 0) continue;
        next.set(row.lineNumber, { ...current.get(row.lineNumber), approved: true });
      }
      return next;
    });
  };

  const untickAll = (): void => {
    haptic('select');
    setDecisions((current) => {
      const next = new Map(current);
      for (const row of review?.rows ?? []) {
        if (row.problem !== null) continue;
        next.set(row.lineNumber, { ...current.get(row.lineNumber), approved: false });
      }
      return next;
    });
  };

  const approved = review?.counts.approved ?? 0;
  const tooManyRows = approved > MAX_COMMIT_ROWS;
  const overLimit =
    preview !== null && preview.limit.remaining !== null && preview.limit.remaining < approved;

  const blocked =
    mappingState.blocking.length > 0 ||
    accountId === '' ||
    approved === 0 ||
    tooManyRows ||
    commit.isPending ||
    switchSheet.isPending;

  const reset = (): void => {
    setFile(null);
    setPreview(null);
    setDuplicates(null);
    setRoles([]);
    setDecisions(new Map());
    setResult(null);
    setFileError(null);
    checkedFor.current = null;
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header>
        <h1 className="text-ink hidden text-xl font-extrabold sm:text-2xl md:block">
          ইমপোর্ট ও এক্সপোর্ট
        </h1>
        <p className="text-ink-muted text-sm">
          {t(
            'import.page.blurb',
            'ব্যাংক বা মোবাইল ওয়ালেটের স্টেটমেন্ট থেকে লেনদেন তুলে আনুন — পিডিএফ, এক্সেল বা সিএসভি, যেটাই হাতে আছে। প্রতিটি সারি আপনি দেখে, খাত ঠিক করে, তারপর যোগ করবেন।',
          )}
        </p>
      </header>

      {/* ---- Step 1: the file ------------------------------------------- */}
      <section className="rounded-card border-rule bg-surface flex flex-col gap-3 border-[1.5px] p-4">
        <StepHeader
          step="১"
          title={t('import.step1.title', 'ফাইল বেছে নিন')}
          hint={t('import.step1.hint', 'পিডিএফ, এক্সেল (.xlsx), সিএসভি বা টেক্সট ফাইল')}
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
          <div className="bg-greenbar flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl p-3 text-sm">
            <span className="text-ink flex min-w-0 items-center gap-1.5 font-medium">
              <FileSpreadsheet className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{preview.filename}</span>
            </span>
            <span className="text-ink-muted text-xs">{bnBytes(file.size)}</span>
            <span className="text-ink-muted text-xs">
              {bnNum(preview.totalRows)} {t('import.file.rows', 'সারি')}
            </span>
            {preview.pageCount !== null ? (
              <span className="text-ink-muted text-xs">
                {bnNum(preview.pageCount)} {t('import.file.pages', 'পাতা')}
              </span>
            ) : null}
            <button
              type="button"
              onClick={reset}
              className="press text-income ml-auto min-h-11 text-xs underline"
            >
              {t('import.file.another', 'অন্য ফাইল দিন')}
            </button>
          </div>
        ) : null}

        {preview?.note ? <Notice tone="warn">{preview.note}</Notice> : null}

        {/* A workbook's transactions are often not on the first tab. The guess
            is stated and can be overruled, because the user can see the tabs
            and we cannot. */}
        {preview && preview.sheetNames.length > 1 ? (
          <label className="text-ink-muted flex flex-wrap items-center gap-2 text-xs">
            {t('import.file.sheet', 'কোন শিট')}
            <Select
              className="w-48"
              value={preview.sheetName ?? ''}
              disabled={switchSheet.isPending}
              onChange={(e) => switchSheet.mutate(e.target.value)}
            >
              {preview.sheetNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        {/* The letterhead a PDF or a workbook carries above its table. Shown so
            somebody can confirm they uploaded the right month and the right
            account, which is not otherwise visible anywhere on this screen. */}
        {preview && preview.preamble.length > 0 ? (
          <details className="border-rule rounded-xl border p-3">
            <summary className="text-ink-muted min-h-11 cursor-pointer text-sm">
              {t('import.file.preamble', 'ফাইলের উপরে যা লেখা আছে')}
            </summary>
            <ul className="text-ink-muted mt-2 flex flex-col gap-1 text-xs">
              {preview.preamble.slice(0, 12).map((line, i) => (
                <li key={`${line}-${i}`}>{line}</li>
              ))}
            </ul>
          </details>
        ) : null}

        {preview && preview.headerRow === null ? (
          <Notice tone="bad">
            {t(
              'import.file.noTable',
              'ফাইলটির ভেতরে লেনদেনের টেবিলটি খুঁজে পাওয়া যায়নি। নিচে কলামগুলো নিজে মিলিয়ে দিন, অথবা ব্যাংক থেকে সিএসভি বা এক্সেল ফাইলটি নামিয়ে দিন।',
            )}
          </Notice>
        ) : null}

        {preview?.gridTruncated ? (
          <Notice tone="warn">
            {t(
              'import.file.truncated',
              'ফাইলটিতে অনেক সারি — একবারে যতগুলো নেওয়া যায় ততগুলোই দেখানো হচ্ছে। বাকিটা আলাদা ফাইল করে দিন।',
            )}{' '}
            ({bnNum(MAX_COMMIT_ROWS)})
          </Notice>
        ) : null}

        {/* The same bytes have been through here before. Worth saying loudly:
            this is the one thing that silently doubles somebody's books. */}
        {preview?.alreadyImported ? (
          <Notice tone="warn">
            এই একই ফাইল {bnDate(preview.alreadyImported.createdAt)} তারিখে ইমপোর্ট করা হয়েছিল (“
            {preview.alreadyImported.filename}”)।{' '}
            {t(
              'import.file.alreadyImported',
              'নিচের তালিকায় যেগুলো আগে থেকেই খাতায় আছে সেগুলোতে সতর্কতা দেখানো হবে।',
            )}
          </Notice>
        ) : null}
      </section>

      {/* ---- Step 2: the mapping ---------------------------------------- */}
      {preview ? (
        <section className="rounded-card border-rule bg-surface flex flex-col gap-4 border-[1.5px] p-4">
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
              /* No round trip. The whole file is already here and core reads
                 it, so flipping the convention re-parses every row locally —
                 and the duplicate check follows, because every date just
                 changed. */
              onDatePreferenceChange={setDatePreference}
              dateConfident={preview.datePreferenceConfident}
              reparsing={recheck.isPending}
              accounts={accounts.data ?? []}
              accountId={accountId}
              onAccountChange={setAccountId}
              preview={(review?.rows ?? []).slice(0, MAPPING_SAMPLE_ROWS).map(toDisplayRow)}
              problems={mappingState.blocking}
              warnings={mappingState.warnings}
            />
          )}
        </section>
      ) : null}

      {/* ---- Step 3: approve, one row at a time ------------------------- */}
      {preview && review ? (
        <section className="rounded-card border-rule bg-surface flex flex-col gap-4 border-[1.5px] p-4">
          <StepHeader
            step="৩"
            title={t('import.step3.title', 'সারি ধরে ধরে দেখে নিন')}
            hint={t('import.step3.hint', 'যেগুলো যোগ করতে চান শুধু সেগুলো বাছাই করুন')}
            done={result !== null}
          />

          <ReviewStep
            review={review}
            categories={categories.data ?? []}
            scope={duplicates?.scope ?? 'ALL_ACCOUNTS'}
            disabled={commit.isPending || result !== null}
            onToggle={(lineNumber, approvedRow) =>
              setDecision(lineNumber, { approved: approvedRow })
            }
            onToggleAllClean={tickClean}
            onUntickAll={untickAll}
            onCategoryChange={(lineNumber, categoryId) => setDecision(lineNumber, { categoryId })}
          />

          {tooManyRows ? (
            <Notice tone="bad">
              একবারে সর্বোচ্চ {bnNum(MAX_COMMIT_ROWS)}টি সারি যোগ করা যায়, এখানে {bnNum(approved)}
              টি বাছাই করা আছে।
            </Notice>
          ) : null}

          {overLimit && preview.limit.remaining !== null ? (
            <Notice tone="warn">
              আপনার প্ল্যানে এই মাসে আর {bnNum(preview.limit.remaining)}টি লেনদেন যোগ করা যাবে, তাই
              পুরোটা হয়তো আঁটবে না।
            </Notice>
          ) : null}

          {review.counts.broken > 0 ? (
            <button
              type="button"
              onClick={() => downloadSkipped(preview.filename, review.rows.map(toDisplayRow))}
              className="press text-income min-h-11 self-start text-sm underline"
            >
              {t('import.review.downloadBroken', 'পড়া যায়নি এমন সারিগুলোর তালিকা নামান')}
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
            <div className="bg-income/10 flex flex-col gap-1 rounded-xl p-3" role="status">
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
                : `${t('import.review.commit', 'বাছাই করা লেনদেন যোগ করুন')} (${bnNum(approved)})`}
            </Button>
          )}
        </section>
      ) : null}

      <ImportHistory />
      <ExportPanel />
    </div>
  );
}

/** The review model in the shape the mapping preview table already speaks. */
function toDisplayRow(row: {
  key: string;
  lineNumber: number;
  date: string | null;
  description: string;
  reference: string | null;
  amountMinor: number | null;
  direction: 'IN' | 'OUT';
  problem: string | null;
  matches: readonly unknown[];
}): DisplayRow {
  return {
    key: row.key,
    lineNumber: row.lineNumber,
    date: row.date,
    description: row.description,
    reference: row.reference,
    categoryName: null,
    amountMinor:
      row.amountMinor === null
        ? null
        : row.direction === 'OUT'
          ? -row.amountMinor
          : row.amountMinor,
    problem: row.problem,
    duplicate: row.matches.length > 0,
  };
}

/** The lines that could not be read, as a file they can fix and re-upload. */
function downloadSkipped(filename: string, rows: readonly DisplayRow[]): void {
  haptic('tap');
  const body = rows
    .filter((row) => row.problem !== null)
    .map((row) => [
      String(row.lineNumber),
      row.date ?? '',
      row.description,
      row.reference ?? '',
      row.amountMinor === null ? '' : minorToPlain(row.amountMinor),
      row.problem ?? '',
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
        'rounded-card flex flex-col items-center gap-2 border-[1.5px] border-dashed p-6 text-center transition-colors',
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
        /* Deliberately wide, and images are in the list on purpose: somebody
           who has only a screenshot should be told plainly why it cannot be
           read and what to send instead, which is a sentence from the server,
           not a file picker that greys the file out with no explanation. */
        accept=".csv,.tsv,.txt,.xlsx,.pdf,text/csv,text/plain,application/pdf,image/*"
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
