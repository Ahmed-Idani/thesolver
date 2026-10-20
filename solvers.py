import re

REGISTRY = {}


def solver(name):
    def register(fn):
        REGISTRY[name] = fn
        return fn

    return register


"""
the decorator is a synthetic sugar:
This is what the @ symbol is doing behind the scenes:
reverse_word = solver("reverseWord")(reverse_word)
"""


def quoted(content):
    return re.search(r'"([^"]+)"', content).group(1)


@solver("reverseWord")
def reverse_word(content):
    # What is "banana" spelled backwards?
    return quoted(content)[::-1]


@solver("wordCount")
def word_count(content):
    # mock rule (invented): sum of letter positions, a=1 ... z=26
    # What is the wordcount of "banana"?
    return sum(ord(c) - ord("a") + 1 for c in quoted(content).lower() if c.isalpha())


@solver("sumNumbers")
def sum_numbers(content):
    # What is 12 + 34?
    return sum(map(int, re.findall(r"-?\d+", content)))
