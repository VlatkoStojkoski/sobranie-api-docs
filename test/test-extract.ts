import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromHar } from '../src/extract.js';

const FIXTURE_HAR = 'test/fixtures/sample.har';

function makeEntry(options: {
  method?: string;
  url?: string;
  requestBody?: string;
  responseBody?: string;
  responseEncoding?: 'base64';
}) {
  return {
    request: {
      method: options.method ?? 'POST',
      url: options.url ?? 'https://www.sobranie.mk/Routing/MakePostRequest',
      postData: options.requestBody === undefined
        ? undefined
        : {
            mimeType: 'application/json',
            text: options.requestBody,
          },
    },
    response: {
      status: 200,
      content: {
        mimeType: 'application/json',
        text: options.responseBody ?? '{}',
        ...(options.responseEncoding ? { encoding: options.responseEncoding } : {}),
      },
    },
  };
}

async function withTempHar(har: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'extract-test-'));
  const file = join(dir, 'input.har');
  await writeFile(file, JSON.stringify(har, null, 2), 'utf-8');
  return file;
}

async function testFixtureExtraction(): Promise<void> {
  const corpora = await extractFromHar(FIXTURE_HAR);

  assert.equal(corpora.length, 4, 'fixture should produce 4 methods');
  assert.deepEqual(
    corpora.map((c) => c.methodName),
    ['GetLegislation', 'GetMembers', 'GetSessions', 'SearchContent'],
    'methods should be sorted and normalized',
  );

  const totalSamples = corpora.reduce((sum, c) => sum + c.samples.length, 0);
  assert.equal(totalSamples, 10, 'fixture should produce 10 valid samples');

  const members = corpora.find((c) => c.methodName === 'GetMembers');
  assert.ok(members, 'GetMembers corpus should exist');
  assert.equal(members.samples.length, 3, 'GetMembers should have 3 samples');

  const firstRequest = members.samples[0]!.request;
  assert.equal(firstRequest.MethodName, 'GetMembers');
  assert.ok('PageSize' in firstRequest, 'snake_case keys should be PascalCase');

  const firstResponse = members.samples[0]!.response as Record<string, unknown>;
  assert.ok('Members' in firstResponse, 'response keys should be PascalCase');
}

async function testFilteringAndNormalizationEdgeCases(): Promise<void> {
  const base64Response = Buffer
    .from(JSON.stringify({
      result_items: [{ item_id: 1, is_ok: true }],
      meta_info: { source_name: 'proxy' },
    }))
    .toString('base64');

  const har = {
    log: {
      entries: [
        makeEntry({
          requestBody: JSON.stringify({ methodname: '/Zeta', page_size: 2, filters: { is_active: true } }),
          responseBody: base64Response,
          responseEncoding: 'base64',
        }),
        makeEntry({
          requestBody: JSON.stringify({ MethodName: 'Alpha', user_id: 42 }),
          responseBody: JSON.stringify({ status_text: 'ok', nested_items: [{ is_public: false }] }),
        }),
        makeEntry({ method: 'GET', requestBody: JSON.stringify({ MethodName: 'IgnoredGet' }) }),
        makeEntry({
          url: 'https://www.sobranie.mk/not-the-gateway',
          requestBody: JSON.stringify({ MethodName: 'IgnoredUrl' }),
        }),
        makeEntry({ requestBody: '{broken', responseBody: '{}' }),
        makeEntry({ requestBody: JSON.stringify({ foo: 'bar' }), responseBody: '{}' }),
        makeEntry({
          requestBody: JSON.stringify({ MethodName: 'IgnoredBadResponse' }),
          responseBody: '{broken',
        }),
      ],
    },
  };

  const harPath = await withTempHar(har);
  try {
    const corpora = await extractFromHar(harPath);

    assert.equal(corpora.length, 2, 'only two valid entries should survive filtering');
    assert.deepEqual(corpora.map((c) => c.methodName), ['Alpha', 'Zeta']);

    const alpha = corpora.find((c) => c.methodName === 'Alpha');
    assert.ok(alpha, 'Alpha method should exist');
    assert.equal(alpha.samples.length, 1);
    assert.equal(alpha.samples[0]!.id, '1', 'sample ids should preserve insertion order across methods');
    assert.equal(alpha.samples[0]!.request.UserId, 42, 'request key should be normalized');

    const zeta = corpora.find((c) => c.methodName === 'Zeta');
    assert.ok(zeta, 'leading slash in MethodName should be stripped');
    assert.equal(zeta.samples[0]!.id, '0');

    const zetaResponse = zeta.samples[0]!.response as Record<string, unknown>;
    assert.ok(Array.isArray(zetaResponse.ResultItems), 'base64 response should be decoded and parsed');
    assert.equal((zetaResponse.MetaInfo as Record<string, unknown>).SourceName, 'proxy');

    const zetaRequest = zeta.samples[0]!.request;
    assert.equal((zetaRequest.Filters as Record<string, unknown>).IsActive, true, 'nested keys should be normalized');
  } finally {
    await rm(join(harPath, '..'), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testFixtureExtraction();
  await testFilteringAndNormalizationEdgeCases();
  console.log('PASS test-extract.ts');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
