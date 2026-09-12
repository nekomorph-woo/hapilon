import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CliIdentity {
  isDev: boolean;
  cliName: "hapilon" | "devhapi";
  /** 默认模式使用用户熟悉的短路径，开发模式使用实际解析后的目录。 */
  homeDisplay: string;
}

const DEFAULT_HOME = resolve(join(homedir(), ".hapilon"));

function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  return raw;
}

/** 根据 HAPILON_HOME 推导面向用户的开发别名和配置目录文案。 */
export function deriveCliIdentity(): CliIdentity {
  const configuredHome = process.env.HAPILON_HOME;
  if (!configuredHome) {
    return { isDev: false, cliName: "hapilon", homeDisplay: "~/.hapilon" };
  }

  const home = resolve(expandHome(configuredHome));
  const isDev = home !== DEFAULT_HOME;
  return {
    isDev,
    cliName: isDev ? "devhapi" : "hapilon",
    homeDisplay: isDev ? home : "~/.hapilon",
  };
}
