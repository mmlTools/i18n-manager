(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {{configured:boolean, folderPath:string, folderDisplay:string, languages:Array<{code:string,filePath:string,flattened:Record<string,string>}>, keys:string[], defaultLanguage:string, aiAvailable:boolean}} */
  let state = {
    configured: false,
    folderPath: "",
    folderDisplay: "",
    languages: [],
    keys: [],
    defaultLanguage: "en",
    aiAvailable: false,
  };

  /**
   * Local UI state - not persisted to extension.
   * - modal: when set, displays a modal overlay
   * - modal.fields: form values, kept across re-renders
   */
  const ui = {
    search: "",
    showOnlyIncomplete: false,
    expandedKeys: new Set(),
    /** @type {null | {kind:'addKey'|'addLanguage'|'renameKey', fields:Record<string,string>, error?:string, oldKey?:string}} */
    modal: null,
  };

  // ─── Messaging ──────────────────────────────────────────────

  function send(type, payload) {
    vscode.postMessage({ type, payload: payload || {} });
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "state") {
      state = msg.payload;
      render();
    } else if (msg.type === "error") {
      console.error("[i18n Data Manager]", msg.payload);
    }
  });

  // ─── Helpers ────────────────────────────────────────────────

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") node.className = v;
        else if (k === "style" && typeof v === "object")
          Object.assign(node.style, v);
        else if (k.startsWith("on") && typeof v === "function")
          node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "dataset" && typeof v === "object")
          Object.assign(node.dataset, v);
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      const arr = Array.isArray(children) ? children : [children];
      for (const c of arr) {
        if (c == null || c === false) continue;
        node.appendChild(
          typeof c === "string" ? document.createTextNode(c) : c,
        );
      }
    }
    return node;
  }

  function isComplete(key) {
    for (const lang of state.languages) {
      const v = lang.flattened[key];
      if (v == null || v === "") return false;
    }
    return true;
  }

  /** True if at least one OTHER language has a value for this key meaning
   *  there is something to translate FROM. Used to enable the AI button. */
  function hasAnySource(key, excludeLang) {
    for (const lang of state.languages) {
      if (lang.code === excludeLang) continue;
      const v = lang.flattened[key];
      if (v != null && v !== "") return true;
    }
    return false;
  }

  function getFilteredKeys() {
    const q = ui.search.trim().toLowerCase();
    return state.keys.filter((k) => {
      if (q && !k.toLowerCase().includes(q)) {
        // Also search inside values
        let hit = false;
        for (const lang of state.languages) {
          const v = lang.flattened[k];
          if (v && v.toLowerCase().includes(q)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      if (ui.showOnlyIncomplete && isComplete(k)) return false;
      return true;
    });
  }

  // ─── Render ─────────────────────────────────────────────────

  function render() {
    // Preserve focus on key inputs that survive re-render
    const active = document.activeElement;
    const focusId = active && active.dataset ? active.dataset.focusId : null;
    const selStart =
      active && "selectionStart" in active ? active.selectionStart : null;
    const selEnd =
      active && "selectionEnd" in active ? active.selectionEnd : null;

    const app = document.getElementById("app");
    app.innerHTML = "";

    if (!state.configured) {
      app.appendChild(renderEmpty());
    } else {
      app.appendChild(renderHeader());
      app.appendChild(renderLanguagesSection());
      app.appendChild(renderToolbar());
      app.appendChild(renderKeysList());
    }

    if (ui.modal) {
      app.appendChild(renderModal());
    }

    // Restore focus
    if (focusId) {
      const next = document.querySelector(
        `[data-focus-id="${CSS.escape(focusId)}"]`,
      );
      if (next) {
        next.focus();
        if (selStart != null && selEnd != null && "setSelectionRange" in next) {
          try {
            next.setSelectionRange(selStart, selEnd);
          } catch (_) {}
        }
      }
    }
  }

  // ─── Empty state ────────────────────────────────────────────

  function renderEmpty() {
    return el("div", { class: "empty" }, [
      el("div", { class: "empty__icon" }, "🌐"),
      el("div", { class: "empty__title" }, "No translations folder configured"),
      el(
        "div",
        { class: "empty__desc" },
        state.folderPath
          ? `The configured path "${state.folderDisplay}" does not exist.`
          : "Pick the folder where your i18n .json files live to get started.",
      ),
      el(
        "button",
        { class: "btn btn--primary", onClick: () => send("configure") },
        "Choose Translations Folder",
      ),
    ]);
  }

  // ─── Header ─────────────────────────────────────────────────

  function renderHeader() {
    return el("div", { class: "header" }, [
      el("div", { class: "header__row" }, [
        el("div", { class: "header__folder", title: state.folderPath }, [
          "📁 ",
          el("strong", null, state.folderDisplay || state.folderPath),
        ]),
        el(
          "button",
          {
            class: "btn btn--ghost",
            title: "Change folder",
            onClick: () => send("configure"),
          },
          "⚙",
        ),
        el(
          "button",
          {
            class: "btn btn--ghost",
            title: "Refresh",
            onClick: () => send("refresh"),
          },
          "↻",
        ),
      ]),
    ]);
  }

  // ─── Languages section ──────────────────────────────────────

  function renderLanguagesSection() {
    const chips = state.languages.map((lang) => {
      const isDefault = lang.code === state.defaultLanguage;
      return el(
        "span",
        {
          class: "lang-chip" + (isDefault ? " lang-chip--default" : ""),
          title: isDefault
            ? `${lang.code} (default) - click to open file`
            : `${lang.code} - click to open file`,
        },
        [
          el(
            "span",
            {
              class: "lang-chip__code",
              onClick: () => send("openFile", { filePath: lang.filePath }),
            },
            lang.code,
          ),
          el(
            "span",
            {
              class: "lang-chip__remove",
              title: `Delete ${lang.code}.json`,
              onClick: (e) => {
                e.stopPropagation();
                send("deleteLanguage", { code: lang.code });
              },
            },
            "×",
          ),
        ],
      );
    });

    const list =
      state.languages.length > 0
        ? el("div", { class: "lang-list" }, chips)
        : el(
            "div",
            { class: "empty-list", style: { padding: "8px 0" } },
            "No language files yet.",
          );

    return el("div", { class: "section" }, [
      el("div", { class: "section__title" }, [
        el("span", null, `Languages (${state.languages.length})`),
        el(
          "button",
          {
            class: "btn btn--ghost",
            onClick: () => openAddLanguageModal(),
          },
          "+ Add",
        ),
      ]),
      list,
    ]);
  }

  // ─── Toolbar ────────────────────────────────────────────────

  function renderToolbar() {
    const filtered = getFilteredKeys();
    return el("div", { class: "toolbar" }, [
      el(
        "button",
        {
          class: "btn btn--primary btn--full",
          disabled: state.languages.length === 0,
          onClick: () => openAddKeyModal(),
        },
        "+ Add Translation Key",
      ),
      el("div", { class: "search" }, [
        el("input", {
          type: "text",
          placeholder: "Search keys or values…",
          value: ui.search,
          "data-focus-id": "search",
          oninput: (e) => {
            ui.search = e.target.value;
            renderKeysOnly();
          },
        }),
      ]),
      el("div", { class: "toolbar__row" }, [
        el("label", { class: "checkbox" }, [
          el("input", {
            type: "checkbox",
            checked: ui.showOnlyIncomplete,
            onchange: (e) => {
              ui.showOnlyIncomplete = e.target.checked;
              renderKeysOnly();
            },
          }),
          "Incomplete only",
        ]),
        el(
          "span",
          { class: "stats" },
          `${filtered.length} / ${state.keys.length}`,
        ),
      ]),
      el(
        "button",
        {
          class: "btn btn--secondary btn--full",
          title:
            "Add empty placeholders for any keys missing from any language file",
          onClick: () => send("syncMissing"),
        },
        "⇅ Sync missing keys",
      ),
    ]);
  }

  // ─── Keys list ──────────────────────────────────────────────

  function renderKeysList() {
    const wrapper = el("div", { class: "keys", id: "keys-list" }, []);
    fillKeysList(wrapper);
    return wrapper;
  }

  function renderKeysOnly() {
    const wrapper = document.getElementById("keys-list");
    if (!wrapper) return render();
    wrapper.innerHTML = "";
    fillKeysList(wrapper);
    // Update stats
    const stats = document.querySelector(".stats");
    if (stats) {
      stats.textContent = `${getFilteredKeys().length} / ${state.keys.length}`;
    }
  }

  function fillKeysList(wrapper) {
    const filtered = getFilteredKeys();
    if (filtered.length === 0) {
      wrapper.appendChild(
        el(
          "div",
          { class: "empty-list" },
          state.keys.length === 0
            ? 'No keys yet. Click "+ Add Translation Key" to start.'
            : "No keys match the filter.",
        ),
      );
      return;
    }
    for (const key of filtered) {
      wrapper.appendChild(renderKey(key));
    }
  }

  function renderKey(key) {
    const expanded = ui.expandedKeys.has(key);
    const complete = isComplete(key);

    const header = el(
      "div",
      {
        class: "key__header",
        onClick: () => {
          if (expanded) ui.expandedKeys.delete(key);
          else ui.expandedKeys.add(key);
          renderKeysOnly();
        },
      },
      [
        el("span", { class: "key__chevron" }, "▶"),
        el("span", { class: "key__name", title: key }, key),
        el(
          "span",
          {
            class:
              "key__status " +
              (complete ? "key__status--ok" : "key__status--warn"),
            title: complete
              ? "All languages have a value"
              : "Missing translations",
          },
          complete
            ? `${state.languages.length}/${state.languages.length}`
            : `${countFilled(key)}/${state.languages.length}`,
        ),
      ],
    );

    const body = expanded ? renderKeyBody(key) : null;

    return el(
      "div",
      { class: "key" + (expanded ? " key--expanded" : "") },
      [header, body].filter(Boolean),
    );
  }

  function countFilled(key) {
    let n = 0;
    for (const lang of state.languages) {
      const v = lang.flattened[key];
      if (v != null && v !== "") n++;
    }
    return n;
  }

  function renderKeyBody(key) {
    const ai = state.aiAvailable;
    const rows = state.languages.map((lang) => {
      const value = lang.flattened[key] ?? "";
      const missing = value === "";
      const ta = el("textarea", {
        rows: 1,
        value,
        "data-focus-id": `value:${key}::${lang.code}`,
        class: missing ? "is-empty" : "",
        placeholder: missing ? "(empty)" : "",
        oninput: (e) => autoGrow(e.target),
        onblur: (e) => {
          const newValue = e.target.value;
          if (newValue !== value) {
            send("updateValue", { key, language: lang.code, value: newValue });
          }
        },
        onkeydown: (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            e.target.blur();
          } else if (e.key === "Escape") {
            e.target.value = value;
            e.target.blur();
          }
        },
      });
      // Auto-grow on render
      setTimeout(() => autoGrow(ta), 0);

      // ✨ per-language AI translate button only appears when an LM is
      // available AND at least one OTHER language has a value to translate from.
      const canTranslate = ai && hasAnySource(key, lang.code);
      const translateBtn = ai
        ? el(
          "button",
          {
            class: "btn btn--ai",
            disabled: !canTranslate,
            title: canTranslate
              ? `Translate ${lang.code} from another language using AI`
              : `Fill in another language first to translate ${lang.code}`,
            onClick: (e) => {
              e.stopPropagation();
              if (!canTranslate) return;
              send("translateValue", { key, targetLang: lang.code });
            },
          },
          "✨",
        )
        : null;

      return el("div", { class: "value-row" }, [
        el("div", { class: "value-row__head" }, [
          el(
            "span",
            {
              class:
                "value-row__lang" +
                (missing ? " value-row__lang--missing" : ""),
            },
            lang.code +
              (lang.code === state.defaultLanguage ? " (default)" : ""),
          ),
          translateBtn,
        ]),
        ta,
      ]);
    });

    // ✨ global "translate all" button only if AI available AND something to
    // translate from AND at least one OTHER language exists.
    const canTranslateAll =
      ai && state.languages.length > 1 && hasAnySource(key, null);
    const translateAllBtn = ai
      ? el(
        "button",
        {
          class: "btn btn--ghost btn--ai-all",
          disabled: !canTranslateAll,
          title: canTranslateAll
            ? "Translate this key into every other language using AI"
            : "Fill in at least one language with a value to enable AI translation",
          onClick: () => {
            if (!canTranslateAll) return;
            send("translateKey", { key });
          },
        },
        "✨ Translate all",
      )
      : null;

    const actions = el(
      "div",
      { class: "key__actions" },
      [
        translateAllBtn,
        el(
          "button",
          {
            class: "btn btn--ghost",
            title: "Rename key",
            onClick: () => openRenameKeyModal(key),
          },
          "Rename",
        ),
        el(
          "button",
          {
            class: "btn btn--ghost btn--danger",
            title: "Delete key from all languages",
            onClick: () => send("deleteKey", { key }),
          },
          "Delete",
        ),
      ].filter(Boolean),
    );

    return el("div", { class: "key__body" }, [...rows, actions]);
  }

  function autoGrow(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  // ─── Modals ─────────────────────────────────────────────────

  function openAddKeyModal() {
    if (state.languages.length === 0) return;
    const fields = { key: "" };
    for (const lang of state.languages) fields["v_" + lang.code] = "";
    ui.modal = { kind: "addKey", fields };
    render();
  }

  function openAddLanguageModal() {
    ui.modal = {
      kind: "addLanguage",
      fields: {
        code: "",
        copyFrom:
          state.defaultLanguage ||
          (state.languages[0] && state.languages[0].code) ||
          "",
      },
    };
    render();
  }

  function openRenameKeyModal(oldKey) {
    ui.modal = {
      kind: "renameKey",
      oldKey,
      fields: { newKey: oldKey },
    };
    render();
  }

  function closeModal() {
    ui.modal = null;
    render();
  }

  function renderModal() {
    if (!ui.modal) return null;
    const m = ui.modal;
    let title, body, onSubmit;

    if (m.kind === "addKey") {
      title = "Add Translation Key";
      body = renderAddKeyForm();
      onSubmit = () => {
        const key = (m.fields.key || "").trim();
        if (!key) {
          m.error = "Key cannot be empty.";
          render();
          return;
        }
        if (state.keys.includes(key)) {
          m.error = `Key "${key}" already exists.`;
          render();
          return;
        }
        const values = {};
        for (const lang of state.languages)
          values[lang.code] = m.fields["v_" + lang.code] || "";
        send("addKey", { key, values });
        // Open the new key after creation
        ui.expandedKeys.add(key);
        closeModal();
      };
    } else if (m.kind === "addLanguage") {
      title = "Add Language";
      body = renderAddLanguageForm();
      onSubmit = () => {
        const code = (m.fields.code || "").trim();
        if (!code) {
          m.error = "Language code cannot be empty.";
          render();
          return;
        }
        if (state.languages.some((l) => l.code === code)) {
          m.error = `"${code}" already exists.`;
          render();
          return;
        }
        send("addLanguage", { code, copyFrom: m.fields.copyFrom || undefined });
        closeModal();
      };
    } else {
      title = "Rename Key";
      body = renderRenameKeyForm();
      onSubmit = () => {
        const newKey = (m.fields.newKey || "").trim();
        if (!newKey) {
          m.error = "New key cannot be empty.";
          render();
          return;
        }
        if (newKey === m.oldKey) {
          closeModal();
          return;
        }
        if (state.keys.includes(newKey)) {
          m.error = `Key "${newKey}" already exists.`;
          render();
          return;
        }
        send("renameKey", { oldKey: m.oldKey, newKey });
        ui.expandedKeys.delete(m.oldKey);
        ui.expandedKeys.add(newKey);
        closeModal();
      };
    }

    const handleKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeModal();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      }
    };

    const backdrop = el(
      "div",
      {
        class: "modal-backdrop",
        onClick: (e) => {
          if (e.target === e.currentTarget) closeModal();
        },
        onkeydown: handleKey,
      },
      [
        el("div", { class: "modal" }, [
          el("div", { class: "modal__head" }, [
            el("span", null, title),
            el(
              "button",
              { class: "modal__close", onClick: closeModal, title: "Close" },
              "×",
            ),
          ]),
          el("div", { class: "modal__body" }, [
            body,
            m.error ? el("div", { class: "field-error" }, m.error) : null,
          ]),
          el("div", { class: "modal__foot" }, [
            el(
              "button",
              { class: "btn btn--secondary", onClick: closeModal },
              "Cancel",
            ),
            el(
              "button",
              { class: "btn btn--primary", onClick: onSubmit },
              m.kind === "addKey"
                ? "Add Key"
                : m.kind === "addLanguage"
                  ? "Create"
                  : "Rename",
            ),
          ]),
        ]),
      ],
    );

    // Focus first input after mount
    setTimeout(() => {
      const first = backdrop.querySelector("input, textarea");
      if (first) first.focus();
    }, 0);

    return backdrop;
  }

  function renderAddKeyForm() {
    const m = ui.modal;
    const langInputs = state.languages.map((lang) => {
      const isDefault = lang.code === state.defaultLanguage;
      return el("div", { class: "field-group" }, [
        el("label", null, lang.code + (isDefault ? " (default)" : "")),
        el("textarea", {
          rows: 2,
          value: m.fields["v_" + lang.code] || "",
          placeholder: isDefault ? "Source value…" : "Translation…",
          oninput: (e) => {
            m.fields["v_" + lang.code] = e.target.value;
          },
        }),
      ]);
    });

    return el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      [
        el("div", { class: "field-group" }, [
          el("label", null, "Key"),
          el("input", {
            type: "text",
            value: m.fields.key,
            placeholder: "e.g. common.buttons.submit",
            oninput: (e) => {
              m.fields.key = e.target.value;
            },
          }),
          el(
            "div",
            { class: "field-help" },
            "Use dots for nested keys. Will be added to all language files.",
          ),
        ]),
        ...langInputs,
      ],
    );
  }

  function renderAddLanguageForm() {
    const m = ui.modal;
    const options = state.languages.map((l) =>
      el(
        "option",
        { value: l.code, selected: l.code === m.fields.copyFrom },
        l.code,
      ),
    );
    return el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      [
        el("div", { class: "field-group" }, [
          el("label", null, "Language code"),
          el("input", {
            type: "text",
            value: m.fields.code,
            placeholder: "e.g. fr, es, de-DE",
            oninput: (e) => {
              m.fields.code = e.target.value;
            },
          }),
          el(
            "div",
            { class: "field-help" },
            "Will create <code>.json in your translations folder.",
          ),
        ]),
        state.languages.length > 0
          ? el("div", { class: "field-group" }, [
              el("label", null, "Copy keys from"),
              el(
                "select",
                {
                  value: m.fields.copyFrom,
                  onchange: (e) => {
                    m.fields.copyFrom = e.target.value;
                  },
                },
                options,
              ),
              el(
                "div",
                { class: "field-help" },
                "Keys are copied with empty values, ready to translate.",
              ),
            ])
          : null,
      ],
    );
  }

  function renderRenameKeyForm() {
    const m = ui.modal;
    return el(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },
      [
        el("div", { class: "field-group" }, [
          el("label", null, "Current key"),
          el("input", { type: "text", value: m.oldKey, disabled: true }),
        ]),
        el("div", { class: "field-group" }, [
          el("label", null, "New key"),
          el("input", {
            type: "text",
            value: m.fields.newKey,
            oninput: (e) => {
              m.fields.newKey = e.target.value;
            },
          }),
        ]),
      ],
    );
  }

  // ─── Boot ───────────────────────────────────────────────────

  send("ready");
})();
