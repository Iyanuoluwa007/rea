import { z } from "zod";
import { localPathStringSchema } from "../localPath.js";
import { digestSchema } from "../digests.js";

const MAX_STRINGS = 2_000;
const ANDROID_NON_LOCALE_QUALIFIERS = new Set([
  "car",
  "desk",
  "television",
  "appliance",
  "watch",
  "vrheadset",
  "night",
  "notnight",
]);

const localeQualifierSchema = z
  .string()
  .min(2)
  .max(16)
  .regex(
    /^(?:[a-z]{2,3}(?:-(?:r?[A-Z]{2}|r?[0-9]{3}))?|b\+[a-z]{2,3}(?:\+[A-Za-z0-9]{2,8})*)$/u,
    "Locale must look like de, pt-BR, pt-rBR, or b+zh+Hans+CN",
  )
  .refine(
    (value) => !ANDROID_NON_LOCALE_QUALIFIERS.has(value.toLowerCase()),
    "Android resource configuration qualifiers are not locales",
  );

/** Locale language tags admitted by Android resource table selection. */
export const androidLocaleQualifierSchema = localeQualifierSchema;

/**
 * The locale of a `values-<qualifiers>` suffix that combines a locale with
 * other configuration qualifiers, such as `en-rUS-v21` or `b+zh+Hans+CN-night`.
 * Android orders qualifiers so only MCC and MNC precede the locale. Returns
 * undefined for a locale-only suffix and for suffixes without a locale.
 */
export const qualifiedResourceLocale = (suffix: string): string | undefined => {
  const tokens = suffix.split("-");
  let start = 0;
  if (/^mcc[0-9]+$/u.test(tokens[start] ?? "")) start += 1;
  if (/^mnc[0-9]+$/u.test(tokens[start] ?? "")) start += 1;
  const language = tokens[start];
  if (language === undefined) return undefined;
  const region = tokens[start + 1];
  const withRegion =
    region !== undefined && /^r(?:[A-Z]{2}|[0-9]{3})$/u.test(region)
      ? `${language}-${region}`
      : language;
  if (!localeQualifierSchema.safeParse(withRegion).success) return undefined;
  const consumed = start + withRegion.split("-").length;
  return consumed < tokens.length || start > 0 ? withRegion : undefined;
};

/**
 * Caller intent for Apktool-backed resource decoding. Apktool is
 * bring-your-own: REA never installs it, and decoding happens in a
 * provider-owned workspace that is removed after the facts are projected.
 */
export const apktoolInputSchemas = {
  inspect_apktool_client: z.strictObject({}),
  decode_android_resources: z.strictObject({
    path: localPathStringSchema.describe("Local APK file to decode"),
    include_strings: z
      .boolean()
      .default(true)
      .describe(
        `Project res/values/strings.xml entries (bounded to ${String(MAX_STRINGS)} entries)`,
      ),
    locale: androidLocaleQualifierSchema
      .optional()
      .describe(
        "Project strings from res/values-<locale>/strings.xml instead of the default table",
      ),
  }),
} as const;

/** Supported Apktool-backed operations. */
export type ApktoolOperation = keyof typeof apktoolInputSchemas;
/** Validated Apktool requests carry their selected operation. */
export type ApktoolRequest = {
  [Name in ApktoolOperation]: {
    operation: Name;
    input: z.infer<(typeof apktoolInputSchemas)[Name]>;
  };
}[ApktoolOperation];

/** Validate operation and input together so their types remain correlated. */
export const apktoolRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_apktool_client"),
    input: apktoolInputSchemas.inspect_apktool_client,
  }),
  z.strictObject({
    operation: z.literal("decode_android_resources"),
    input: apktoolInputSchemas.decode_android_resources,
  }),
]);

const client = z.strictObject({
  command: z.string().min(1),
  command_source: z.enum(["environment", "path"]),
  apktool_version: z.string().min(1).nullable(),
});

/** Portable Apktool observations with explicit coverage limitations. */
export const apktoolResultSchemas = {
  inspect_apktool_client: z.strictObject({
    client,
  }),
  decode_android_resources: z.strictObject({
    client,
    target: z.strictObject({
      path: localPathStringSchema,
      bytes: z.number().int().nonnegative(),
      sha256: digestSchema,
    }),
    metadata: z.strictObject({
      version_name: z.string().nullable(),
      version_code: z
        .string()
        .nullable()
        .describe(
          "Version code exactly as apktool.yml prints it, e.g. '45' or '45.1'",
        ),
      min_sdk_version: z.string().nullable(),
      target_sdk_version: z.string().nullable(),
      package_name: z.string().nullable(),
    }),
    manifest: z.string().nullable(),
    strings: z.array(
      z.strictObject({
        name: z.string().min(1),
        value: z.string(),
      }),
    ),
    locale: z.string().nullable(),
    locales: z.array(z.string().min(1)),
    decoded_file_count: z.number().int().nonnegative(),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
