"""
Template registry — loads YAML bank templates and matches them against raw OCR text.

Each YAML file in src/templates/ defines how to identify a specific bank's receipt
and which regex patterns to use for each field, providing more accurate extraction
than the generic fallback patterns.
"""

from __future__ import annotations

import re
import logging
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

import yaml

TEMPLATES_DIR = Path(__file__).parent.parent / "templates"
LOGGER = logging.getLogger(__name__)


class BankTemplate:
    """Represents a single bank receipt template loaded from a YAML file."""

    def __init__(self, data: dict) -> None:
        self.id: str = data["id"]
        self.name: str = data["name"]
        self.bank_name: Optional[str] = data.get("bank_name")
        self.payment_type: Optional[str] = data.get("payment_type")  # overrides auto-detect
        # Do not guess fields not present in a template when the document is
        # too degraded for a generic regex to be trustworthy.
        self.strict_fields: bool = bool(data.get("strict_fields", False))

        identify = data.get("identify", {})
        self._required: list[str] = [kw.lower() for kw in identify.get("required", [])]
        self._optional: list[str] = [kw.lower() for kw in identify.get("optional", [])]

        # field_name → list[regex_pattern_str]  (keyword-based extraction)
        self.fields: dict[str, list[str]] = data.get("fields", {})
        # Values known for the whole document type, such as USD for Ecuadorian
        # bank receipts that display only the "$" symbol.
        self.defaults: dict[str, str] = data.get("defaults", {})
        # Derived values used by formats that show a debit total and a fee,
        # but whose primary amount is hard for OCR to read.
        self.computed_fields: dict[str, dict] = data.get("computed_fields", {})

        # layout section → positional extraction support
        layout = data.get("layout", {})
        self.layout_sort: str = layout.get("sort", "top_to_bottom")
        # field_name → {index?, anchor?, extract?}
        self.layout_fields: dict[str, dict] = layout.get("fields", {})

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def match_score(self, text: str) -> float:
        """
        Return a score > 0 if this template matches the text, 0 otherwise.

        Score formula:
          - 1.0  base (if ALL required keywords found)
          - +0.2 per optional keyword found
        """
        lower = text.lower()
        if not self._required:
            return 0.0
        if not all(kw in lower for kw in self._required):
            return 0.0

        score = 1.0
        for kw in self._optional:
            if kw in lower:
                score += 0.2
        return round(score, 2)

    # ------------------------------------------------------------------
    # Field extraction
    # ------------------------------------------------------------------

    def extract_field(self, field_name: str, text: str) -> Optional[str]:
        """Try each pattern for *field_name* and return first match, or None."""
        flags = re.IGNORECASE | re.DOTALL
        for pattern in self.fields.get(field_name, []):
            try:
                m = re.search(pattern, text, flags)
                if m:
                    return m.group(1).strip()
            except re.error:
                continue
        return None

    def default_for(self, field_name: str) -> Optional[str]:
        """Return a template-defined value when the receipt omits the label."""
        value = self.defaults.get(field_name)
        return str(value) if value is not None else None

    def extract_computed_field(self, field_name: str, text: str) -> Optional[str]:
        """Calculate a field according to a template-defined operation."""
        spec = self.computed_fields.get(field_name)
        if not spec or spec.get("operation") != "subtract":
            return None

        def _number(patterns: list[str]) -> Optional[Decimal]:
            for pattern in patterns:
                try:
                    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
                except re.error:
                    continue
                if not match:
                    continue
                value = match.group(1).replace(",", "")
                try:
                    return Decimal(value)
                except InvalidOperation:
                    continue
            return None

        minuend = _number(spec.get("minuend", []))
        subtrahend = _number(spec.get("subtrahend", []))
        if minuend is None or subtrahend is None:
            return None
        return f"{minuend - subtrahend:.2f}"

    def extract_field_positional(
        self,
        field_name: str,
        sorted_blocks: list,
        img_dims: tuple,
    ) -> Optional[str]:
        """
        Extract *field_name* using positional block layout defined in the template's
        ``layout.fields`` section.

        Each field spec in the YAML can have:
        - ``index: N``        — Nth block in the sorted list (0-based).
        - ``anchor: top_right`` — Rightmost block within the top 25 % of the image.
        - ``extract: pattern``  — Optional regex applied to the raw block text;
                                   group(1) is returned.  If it doesn't match,
                                   the full block text is returned.
        """
        spec = self.layout_fields.get(field_name)
        if spec is None or not sorted_blocks:
            return None

        img_width, img_height = img_dims if img_dims else (0, 0)
        raw_text: Optional[str] = None

        # ── Anchor-based selection ──────────────────────────────────────────
        anchor = spec.get("anchor")
        if anchor == "top_right":
            top_pct = spec.get("top_region_pct", 0.25)
            top_region = [b for b in sorted_blocks if img_height and b["cy"] < img_height * top_pct]
            if top_region:
                raw_text = max(top_region, key=lambda b: b["cx"])["text"]
            else:
                # Fallback: global rightmost block
                raw_text = max(sorted_blocks, key=lambda b: b["cx"])["text"]

        # ── Index-based selection ───────────────────────────────────────────
        elif "index" in spec:
            idx = int(spec["index"])
            if 0 <= idx < len(sorted_blocks):
                raw_text = sorted_blocks[idx]["text"]

        if raw_text is None:
            return None

        # ── Optional regex post-processing ─────────────────────────────────
        extract_pat = spec.get("extract")
        if extract_pat:
            try:
                m = re.search(extract_pat, raw_text, re.IGNORECASE)
                if m:
                    return m.group(1).strip()
            except re.error:
                pass

        return raw_text.strip()


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class TemplateRegistry:
    """Singleton registry that loads all YAML templates and picks the best match."""

    _instance: Optional["TemplateRegistry"] = None

    def __init__(self) -> None:
        self._templates: list[BankTemplate] = []
        self._load_templates()

    @classmethod
    def get_instance(cls) -> "TemplateRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def _load_templates(self) -> None:
        if not TEMPLATES_DIR.exists():
            return
        for path in sorted(TEMPLATES_DIR.glob("*.yaml")):
            try:
                with path.open(encoding="utf-8") as f:
                    data = yaml.safe_load(f)
                self._templates.append(BankTemplate(data))
                LOGGER.info("Loaded OCR template: %s", data.get("id"))
            except Exception as exc:  # noqa: BLE001
                LOGGER.warning("Failed to load OCR template %s: %s", path.name, exc)

    def reload(self) -> None:
        """Reload all templates from disk (useful for hot-reload in development)."""
        self._templates.clear()
        self._load_templates()

    # ------------------------------------------------------------------
    # Matching
    # ------------------------------------------------------------------

    def find_best_template(self, text: str) -> Optional[BankTemplate]:
        """Return the highest-scoring template for *text*, or None if no match."""
        best: Optional[BankTemplate] = None
        best_score = 0.0
        for tpl in self._templates:
            score = tpl.match_score(text)
            if score > best_score:
                best_score = score
                best = tpl
        return best if best_score > 0 else None

    @property
    def loaded_templates(self) -> list[str]:
        return [t.id for t in self._templates]


# Module-level singleton
template_registry = TemplateRegistry.get_instance()
