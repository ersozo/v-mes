"""Python doğrulayıcısını TS ile ortak test vektörlerine karşı sınar."""

import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from mes_api.plc import AddressError, TagDefinition, find_overlapping_tags, parse_s7_address, validate_tag_list

_candidates = [os.environ.get("PLC_VECTORS", ""), Path(__file__).parents[3] / "packages/contracts/test-vectors/plc.json"]
VECTORS_PATH = next((Path(p) for p in _candidates if p and Path(p).is_file()), None)
pytestmark = pytest.mark.skipif(VECTORS_PATH is None, reason="test-vectors/plc.json bulunamadı (PLC_VECTORS ayarlayın)")
V = json.loads(VECTORS_PATH.read_text(encoding="utf-8")) if VECTORS_PATH else {"addresses": {"valid": [], "invalid": []}, "tags": {"valid": [], "invalid": []}, "tagLists": {"valid": [], "invalid": []}}


@pytest.mark.parametrize("raw,expected,canonical", V["addresses"]["valid"])
def test_valid_addresses(raw, expected, canonical):
    a = parse_s7_address(raw)
    assert {"db": a.db, "type": a.type, "offset": a.offset, **({"bit": a.bit} if a.bit is not None else {})} == expected
    assert a.format() == canonical


@pytest.mark.parametrize("raw", V["addresses"]["invalid"])
def test_invalid_addresses(raw):
    with pytest.raises(AddressError):
        parse_s7_address(raw)


@pytest.mark.parametrize("tag", V["tags"]["valid"])
def test_valid_tags(tag):
    TagDefinition(**tag)


@pytest.mark.parametrize("tag", V["tags"]["invalid"])
def test_invalid_tags(tag):
    with pytest.raises(ValidationError):
        TagDefinition(**tag)


@pytest.mark.parametrize("tags", V["tagLists"]["valid"])
def test_valid_lists(tags):
    validate_tag_list([TagDefinition(**t) for t in tags])


@pytest.mark.parametrize("tags", V["tagLists"]["invalid"])
def test_invalid_lists(tags):
    with pytest.raises(ValueError):
        validate_tag_list([TagDefinition(**t) for t in tags])


def test_address_is_normalized_and_overlaps_found():
    tags = [TagDefinition(name="count", address="db1,di0", role="total_count"),
            TagDefinition(name="low", address="DB1,W2", role="process")]
    assert tags[0].address == "DB1,DINT0"
    assert find_overlapping_tags(tags) == [("count", "low")]
