"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { EnvSettings } from "@/lib/types";

interface Props {
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
}

function Field({
  label,
  envKey,
  settings,
  onChange,
  type = "text",
  placeholder,
  hint,
}: {
  label: string;
  envKey: string;
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <input
        type={type}
        value={settings[envKey] ?? ""}
        onChange={(e) => onChange(envKey, e.target.value)}
        placeholder={placeholder}
        className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
      />
      {hint && (
        <span className="text-[9px] font-mono text-muted">{hint}</span>
      )}
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <input
        type="text"
        value={value}
        readOnly
        className="bg-bg/60 border border-border rounded px-3 py-2 text-xs font-mono text-muted cursor-not-allowed"
      />
      {hint && <span className="text-[9px] font-mono text-muted">{hint}</span>}
    </div>
  );
}

function SelectField({
  label,
  envKey,
  options,
  settings,
  onChange,
}: {
  label: string;
  envKey: string;
  options: { value: string; label: string }[];
  settings: EnvSettings;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
        {label}
      </label>
      <select
        value={settings[envKey] ?? ""}
        onChange={(e) => onChange(envKey, e.target.value)}
        className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function TokenSettings({ settings, onChange }: Props) {
  const [socialLinks, setSocialLinks] = useState<Array<{ id: string; kind: string; url: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const socialRaw = settings.TOKEN_SOCIAL_LINKS ?? "[]";

  const normalizeSocialLinks = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((v) => String(v).trim())
        .filter((v) => v.length > 0);
    } catch {
      return [];
    }
  };

  const serializedFromState = useMemo(() => {
    const urls = socialLinks
      .map((x) => x.url.trim())
      .filter((x) => x.length > 0);
    return JSON.stringify(urls);
  }, [socialLinks]);

  useEffect(() => {
    const envUrls = normalizeSocialLinks(socialRaw);
    const envSerialized = JSON.stringify(envUrls);
    if (envSerialized === serializedFromState) return;

    setSocialLinks(
      envUrls.map((url, idx) => ({
        id: `${Date.now()}-${idx}`,
        kind: "custom",
        url,
      }))
    );
  }, [socialRaw, serializedFromState]);

  const syncSocialLinks = (next: Array<{ id: string; kind: string; url: string }>) => {
    setSocialLinks(next);
    const urls = next
      .map((x) => x.url.trim())
      .filter((x) => x.length > 0);
    onChange("TOKEN_SOCIAL_LINKS", JSON.stringify(urls));
  };

  const addSocialLink = () => {
    const next = [
      ...socialLinks,
      { id: `${Date.now()}-${Math.random()}`, kind: "custom", url: "" },
    ];
    syncSocialLinks(next);
  };

  const updateSocialLink = (id: string, patch: Partial<{ kind: string; url: string }>) => {
    const next = socialLinks.map((item) => (item.id === id ? { ...item, ...patch } : item));
    syncSocialLinks(next);
  };

  const removeSocialLink = (id: string) => {
    const next = socialLinks.filter((item) => item.id !== id);
    syncSocialLinks(next);
  };

  const handleImageUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/token-image", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.path) {
        throw new Error(data.error ?? "Upload failed");
      }
      onChange("TOKEN_IMAGE_PATH", data.path);
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] font-mono text-muted">
        Token metadata and mint configuration
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Token Name"
          envKey="TOKEN_NAME"
          settings={settings}
          onChange={onChange}
          placeholder="My Token"
        />
        <Field
          label="Token Symbol"
          envKey="TOKEN_SYMBOL"
          settings={settings}
          onChange={onChange}
          placeholder="MKT"
        />
      </div>

      <Field
        label="Description"
        envKey="TOKEN_DESCRIPTION"
        settings={settings}
        onChange={onChange}
        placeholder="A brief description of the token"
      />

      <div className="grid grid-cols-2 gap-3">
        <SelectField
          label="Token Program"
          envKey="TOKEN_PROGRAM"
          settings={settings}
          onChange={onChange}
          options={[
            { value: "TOKEN_2022", label: "Token-2022 (recommended)" },
            { value: "TOKEN", label: "Token (legacy)" },
          ]}
        />
        <Field
          label="Decimals"
          envKey="TOKEN_DECIMALS"
          settings={settings}
          onChange={onChange}
          type="number"
          placeholder="6"
        />
      </div>

      <ReadOnlyField
        label="Initial Supply (raw units)"
        value={settings.TOKEN_INITIAL_SUPPLY_RAW ?? ""}
        hint="Read-only here. Change supply only in your mint flow settings."
      />

      <div className="flex flex-col gap-2">
        <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
          Token Image
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={settings.TOKEN_IMAGE_PATH ?? ""}
            placeholder="No image uploaded yet"
            className="flex-1 bg-bg/60 border border-border rounded px-3 py-2 text-xs font-mono text-muted cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={`px-3 py-2 text-xs font-mono font-semibold rounded border transition-all ${
              uploading
                ? "border-border text-muted cursor-not-allowed"
                : "border-accent/40 text-accent hover:bg-accent/10 hover:border-accent/70"
            }`}
          >
            {uploading ? "Uploading..." : "Upload Image"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImageUpload(file);
              e.currentTarget.value = "";
            }}
          />
        </div>
        <span className="text-[9px] font-mono text-muted">
          Uploads to <code>image/uploads/</code> and auto-sets TOKEN_IMAGE_PATH.
        </span>
        {uploadError && (
          <span className="text-[9px] font-mono text-danger">{uploadError}</span>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <label className="text-[10px] font-mono uppercase tracking-wider text-text-secondary">
            Social Links
          </label>
          <button
            type="button"
            onClick={addSocialLink}
            className="px-2 py-1 text-[10px] font-mono font-semibold rounded border border-accent/40 text-accent hover:bg-accent/10 hover:border-accent/70 transition-all"
          >
            + Add Field
          </button>
        </div>

        {socialLinks.length === 0 ? (
          <div className="text-[10px] font-mono text-muted border border-border rounded px-3 py-2 bg-bg/40">
            No social links added.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {socialLinks.map((link) => (
              <div key={link.id} className="grid grid-cols-[120px_1fr_auto] gap-2">
                <select
                  value={link.kind}
                  onChange={(e) => updateSocialLink(link.id, { kind: e.target.value })}
                  className="bg-bg border border-border rounded px-2 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="telegram">Telegram</option>
                  <option value="twitter">Twitter</option>
                  <option value="website">Website</option>
                  <option value="discord">Discord</option>
                  <option value="custom">Custom</option>
                </select>
                <input
                  type="text"
                  value={link.url}
                  onChange={(e) => updateSocialLink(link.id, { url: e.target.value })}
                  placeholder={
                    link.kind === "telegram"
                      ? "https://t.me/yourchannel"
                      : link.kind === "twitter"
                        ? "https://x.com/yourhandle"
                        : link.kind === "website"
                          ? "https://yourwebsite.com"
                          : link.kind === "discord"
                            ? "https://discord.gg/..."
                            : "https://..."
                  }
                  className="bg-bg border border-border rounded px-3 py-2 text-xs font-mono text-text-primary focus:border-accent focus:outline-none transition-colors placeholder:text-muted"
                />
                <button
                  type="button"
                  onClick={() => removeSocialLink(link.id)}
                  className="px-2 py-2 text-[10px] font-mono font-semibold rounded border border-danger/40 text-danger hover:bg-danger/10 hover:border-danger/70 transition-all"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <span className="text-[9px] font-mono text-muted">
          Saved as TOKEN_SOCIAL_LINKS JSON array automatically.
        </span>
      </div>
    </div>
  );
}
