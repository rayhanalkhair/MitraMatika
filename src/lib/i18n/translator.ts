import {
  createTranslator,
  type Messages,
  type NamespaceKeys,
  type NestedKeyOf,
} from "next-intl";
import { defaultLocale, type Locale } from "./config";
import idMessages from "../../../messages/id.json";
import enMessages from "../../../messages/en.json";

type Catalog = typeof idMessages;

/**
 * The type of a translator for one namespace (what `useTranslations(ns)` and
 * `await getTranslations(ns)` return). Pure functions that need text take one as a parameter
 * instead of calling hooks.
 */
export type Translator<
  Namespace extends NamespaceKeys<Messages, NestedKeyOf<Messages>> = never,
> = ReturnType<typeof createTranslator<Messages, Namespace>>;

const catalogs: Record<Locale, Catalog> = { id: idMessages, en: enMessages };

/**
 * A translator that does not need a request: background work (the sign-in email), scripts and
 * Better Auth hooks. Defaults to Indonesian; the sign-in email always is.
 */
export function createStaticTranslator<
  Namespace extends NamespaceKeys<Messages, NestedKeyOf<Messages>> = never,
>(namespace?: Namespace, locale: Locale = defaultLocale): Translator<Namespace> {
  return createTranslator({
    locale,
    messages: catalogs[locale],
    ...(namespace === undefined ? {} : { namespace }),
  });
}

/**
 * True when the Indonesian catalog has `key` directly under `namespace` (a dotted path such as
 * `auth.errors`). Lets a feature validate a message key without importing the catalog file.
 */
export function hasMessageKey(namespace: string, key: string): boolean {
  let node: unknown = idMessages;
  for (const part of namespace.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "object" && node !== null && Object.hasOwn(node, key);
}
