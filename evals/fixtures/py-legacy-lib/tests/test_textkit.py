from nose.tools import assert_equal
from textkit import words, title_case


def test_words():
    assert_equal(words(" a  b "), ["a", "b"])


def test_title_case():
    assert_equal(title_case("hello world"), "Hello World")
