/**
 * GitHub の 422 で、GitHub の言う理由（errors[]）を捨てぬ試験。
 *
 * review submit --to github が 422 で落ちた時、理由（errors[]）を捨てると、
 * 因が権限の話として説明され、inline の行が diff の外にあるという本当の因が
 * 見えなかった。実の GitHub へは撃たぬ——fetch は注入の偽物である。
 */
import { describe, expect, test } from 'bun:test';
import { createPrReview, createIssue } from '../src/bot';
import { reviewSubmitFailureLines } from '../src/botmain';

const PAYLOAD = {
  commit_id: 'a'.repeat(40),
  body: '総括',
  event: 'COMMENT',
  comments: [{ path: 'src/a.ts', line: 999, body: '指摘' }],
};

// GitHub が diff の外の行へ inline を置いた時に返す形（errors[] の各件に resource・field・message）
const DIFF_OUTSIDE = {
  message: 'Unprocessable Entity',
  errors: [{ resource: 'PullRequestReviewComment', field: 'line', message: 'line must be part of the diff' }],
  documentation_url: 'https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request',
};

const respond = (status: number, body: string) => async () => new Response(body, { status });

const failureOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('落ちなんだ');
};

describe('fail は errors[] を文へ足す', () => {
  test('errors[] の resource・field・message が文に出る', async () => {
    const msg = await failureOf(createPrReview(respond(422, JSON.stringify(DIFF_OUTSIDE)), 'tok', 'o/r', 1, PAYLOAD));
    expect(msg).toContain('HTTP 422: Unprocessable Entity');
    expect(msg).toContain('PullRequestReviewComment');
    expect(msg).toContain('line');
    expect(msg).toContain('line must be part of the diff');
  });

  test('errors が無ければ今の文のまま', async () => {
    const msg = await failureOf(
      createPrReview(respond(422, JSON.stringify({ message: 'Unprocessable Entity' })), 'tok', 'o/r', 1, PAYLOAD),
    );
    expect(msg).toBe('PR review の投稿 に失敗した（HTTP 422: Unprocessable Entity）');
  });

  test('errors が空の配列なら今の文のまま', async () => {
    const msg = await failureOf(
      createPrReview(respond(422, JSON.stringify({ message: 'Unprocessable Entity', errors: [] })), 'tok', 'o/r', 1, PAYLOAD),
    );
    expect(msg).toBe('PR review の投稿 に失敗した（HTTP 422: Unprocessable Entity）');
  });

  test('本文が JSON でなければ今の文のまま', async () => {
    const msg = await failureOf(createPrReview(respond(422, '<html>bad gateway</html>'), 'tok', 'o/r', 1, PAYLOAD));
    expect(msg).toBe('PR review の投稿 に失敗した（HTTP 422）');
  });

  test('issue create の 422 にも同じく効く', async () => {
    const body = JSON.stringify({
      message: 'Validation Failed',
      errors: [{ resource: 'Issue', field: 'title', message: 'title is too long (maximum is 256 characters)' }],
    });
    const msg = await failureOf(createIssue(respond(422, body), 'tok', 'o/r', '題', '本文', []));
    expect(msg).toContain('HTTP 422: Validation Failed');
    expect(msg).toContain('Issue');
    expect(msg).toContain('title is too long (maximum is 256 characters)');
  });

  test('token は文に混ざらぬ（errors を足しても）', async () => {
    const msg = await failureOf(createPrReview(respond(422, JSON.stringify(DIFF_OUTSIDE)), 'ghs_SECRET', 'o/r', 1, PAYLOAD));
    expect(msg).not.toContain('ghs_SECRET');
  });
});

describe('review submit --to github の 422 の文', () => {
  test('標準エラーへ出す文に、errors の中身と、diff の外の行という因の一行が出る', async () => {
    const e = await createPrReview(respond(422, JSON.stringify(DIFF_OUTSIDE)), 'tok', 'o/r', 1, PAYLOAD).catch((x: unknown) => x);
    const lines = reviewSubmitFailureLines(e);
    const text = lines.join('\n');
    expect(lines[0]!.startsWith('  [github] ')).toBe(true);
    expect(text).toContain('line must be part of the diff');
    expect(text).toContain('diff の外');
    expect(text).toContain('一件外れれば review 全体が落ちる');
  });

  test('422 でない失敗には diff の外の一行を添えぬ', async () => {
    const e = await createPrReview(respond(500, JSON.stringify({ message: 'Server Error' })), 'tok', 'o/r', 1, PAYLOAD).catch(
      (x: unknown) => x,
    );
    const text = reviewSubmitFailureLines(e).join('\n');
    expect(text).toContain('HTTP 500');
    expect(text).not.toContain('diff の外');
  });
});
