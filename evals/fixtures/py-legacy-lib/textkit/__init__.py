import six


def words(text):
    if not isinstance(text, six.string_types):
        raise TypeError("text must be a string")
    return [w for w in text.split() if w]


def title_case(text):
    return " ".join(w[:1].upper() + w[1:] for w in words(text))
