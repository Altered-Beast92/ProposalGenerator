"""Semantic recolouring for the proposal decks.

The golden PDFs contain literal hex values. Recolouring maps each of those back
to the role it was playing (``#8734EF`` -> ``primary``) and re-emits whatever
the active theme assigns to that role. Anything unrecognised is passed through
untouched, so an unmapped colour shows up as "still the original" rather than
as a crash or a silently wrong hue.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

def _find_spec_dir() -> Path:
    """See replay._find_spec_dir - the deployed bundle carries its own copy."""
    here = Path(__file__).resolve()
    candidates = [here.parent / "spec", here.parents[2] / "packages" / "spec"]
    return next((p for p in candidates if p.is_dir()), candidates[-1])


SPEC_DIR = _find_spec_dir()


def _normalise(value: str) -> str:
    value = value.strip().upper()
    if not value.startswith("#"):
        value = "#" + value
    # Expand shorthand (#ABC -> #AABBCC) so lookups are comparable.
    if len(value) == 4:
        value = "#" + "".join(c * 2 for c in value[1:])
    return value


@dataclass(frozen=True)
class Palette:
    """Maps the decks' literal colours onto a theme, via semantic roles."""

    roles: dict[str, str]
    alias_to_role: dict[str, str]

    @classmethod
    def load(cls, theme: dict[str, str] | None = None) -> "Palette":
        spec = json.loads((SPEC_DIR / "palette.json").read_text(encoding="utf-8"))
        roles: dict[str, str] = {}
        alias_to_role: dict[str, str] = {}

        for role, meta in spec["roles"].items():
            roles[role] = _normalise(meta["default"])
            for alias in meta["aliases"]:
                alias_to_role[_normalise(alias)] = role

        if theme:
            # "$"-prefixed keys are annotations ($comment, $name), not roles.
            theme = {k: v for k, v in theme.items() if not k.startswith("$")}
            unknown = set(theme) - set(roles)
            if unknown:
                raise ValueError(
                    f"unknown palette role(s): {', '.join(sorted(unknown))}. "
                    f"valid roles: {', '.join(sorted(roles))}"
                )
            roles.update({k: _normalise(v) for k, v in theme.items()})

        return cls(roles=roles, alias_to_role=alias_to_role)

    def role_of(self, colour: str) -> str | None:
        return self.alias_to_role.get(_normalise(colour))

    def resolve(self, colour: str) -> str:
        """Return the themed colour for a literal from the golden deck."""
        role = self.role_of(colour)
        return self.roles[role] if role else _normalise(colour)

    def unmapped(self, colours: list[str]) -> list[str]:
        """Literals with no role, i.e. colours a theme cannot reach."""
        seen = {_normalise(c) for c in colours}
        return sorted(c for c in seen if c not in self.alias_to_role)
