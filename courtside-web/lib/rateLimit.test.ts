import { describe, expect, it } from "vitest";
import { rateLimit, WINDOW_MS } from "./rateLimit";

// 이 파일은 모듈 스코프 Map(buckets)에 상태를 들고 있어서(proxy.ts가 그렇게 쓰라고 설계됨)
// 테스트끼리 키가 겹치면 서로 간섭한다 - 매 테스트마다 고유한 key 접두사를 쓴다.
let seq = 0;
const key = () => `test:${seq++}`;

describe("rateLimit", () => {
  it("첫 요청은 허용", () => {
    const r = rateLimit(key(), 3);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterSec).toBe(0);
  });

  it("limit번째까지는 허용, 그다음은 차단", () => {
    const k = key();
    const now = Date.now();
    expect(rateLimit(k, 2, now).allowed).toBe(true);
    expect(rateLimit(k, 2, now).allowed).toBe(true);
    const third = rateLimit(k, 2, now);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("창이 지나면 카운터가 리셋된다", () => {
    const k = key();
    const now = Date.now();
    expect(rateLimit(k, 1, now).allowed).toBe(true);
    expect(rateLimit(k, 1, now).allowed).toBe(false);
    // 창 종료 직후 - 새 창이므로 다시 허용돼야 한다.
    expect(rateLimit(k, 1, now + WINDOW_MS + 1).allowed).toBe(true);
  });

  it("retryAfterSec은 최소 1초(0을 주면 클라이언트가 즉시 재시도해버림)", () => {
    const k = key();
    const now = Date.now();
    rateLimit(k, 1, now);
    // 창 끝나기 1ms 전에 막힘 - 반올림해도 최소 1을 보장해야 한다.
    const r = rateLimit(k, 1, now + WINDOW_MS - 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("다른 버킷(다른 key)은 서로 카운터를 공유하지 않는다", () => {
    const now = Date.now();
    const a = `bucket-a:${key()}`;
    const b = `bucket-b:${key()}`;
    expect(rateLimit(a, 1, now).allowed).toBe(true);
    // a가 막혔어도 b는 독립적으로 허용돼야 한다.
    expect(rateLimit(b, 1, now).allowed).toBe(true);
  });
});
