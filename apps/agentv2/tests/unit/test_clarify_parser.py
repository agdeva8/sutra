"""The coach's question cards: answer chips are found whether the model indents its bullets or not."""
from agentv2.coach.tools_block import extract_clarifying_questions


def test_flush_left_bullets_under_a_question_become_its_options():
    text = "Two questions:\n\n1. When is it due?\n- Within 3 months\n- No date\n\n2. How many hours a week?\n- 2 to 5\n- 5 to 10\n"
    qs = extract_clarifying_questions(text)
    assert [q["question"] for q in qs] == ["When is it due?", "How many hours a week?"]
    assert qs[0]["options"] == ["Within 3 months", "No date"] and qs[1]["options"] == ["2 to 5", "5 to 10"]


def test_indented_bullets_still_work_and_prose_after_a_list_does_not_become_an_option():
    text = "1. Which one?\n   - A\n   - B\nThat is all I need to know for now.\n- stray bullet\n"
    (q,) = extract_clarifying_questions(text)
    assert q["options"] == ["A", "B"]
