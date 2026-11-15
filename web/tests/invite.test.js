import { describe, it, expect } from "vitest";
import { parseInviteInput } from "../src/invite.js";

describe("parseInviteInput", () => {
  it("aceita código DROCSID- da Cloudflare", () => {
    const res = parseInviteInput("DROCSID-cool-frog-alpha-1234567890abcdef");
    expect(res).toEqual({
      origin: "https://cool-frog-alpha.trycloudflare.com",
      key: "1234567890abcdef",
    });
  });

  it("aceita código LHR- do localhost.run", () => {
    const res = parseInviteInput("lhr-meu-tunel-9988-abcdef1234567890");
    expect(res).toEqual({
      origin: "https://meu-tunel-9988.lhr.life",
      key: "abcdef1234567890",
    });
  });

  it("extrai origin e #key de URL colada dentro de frase", () => {
    const res = parseInviteInput("Entra aí: https://abc-xyz.trycloudflare.com/#key=secretkey123456789 !");
    expect(res).toEqual({
      origin: "https://abc-xyz.trycloudflare.com",
      key: "secretkey123456789",
    });
  });

  it("rejeita chave curta (< 16 chars) ou texto inválido", () => {
    expect(parseInviteInput("")).toBeNull();
    expect(parseInviteInput("DROCSID-abc-curta")).toBeNull();
    expect(parseInviteInput("https://abc.trycloudflare.com/#key=short")).toBeNull();
    expect(parseInviteInput("texto aleatório")).toBeNull();
  });
});
