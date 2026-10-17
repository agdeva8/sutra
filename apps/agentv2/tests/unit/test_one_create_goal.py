"""One Add-goal plan creates one goal: a reply may carry only one `create_goal`."""
import json

from agentv2.coach.tools_block import TOOL_END, TOOL_START, parse_proposals


def _block(items: list[dict]) -> str:
    return f"{TOOL_START}\n{json.dumps(items)}\n{TOOL_END}"


def _create(proposal_id: str, title: str) -> dict:
    return {"id": proposal_id, "action": "create_goal", "args": {"title": title, "horizon": "short"}}


def _milestone(proposal_id: str, title: str, goal_title: str) -> dict:
    return {
        "id": proposal_id,
        "action": "add_milestone",
        "args": {"title": title, "goal_title": goal_title, "target_date": "2027-03-14"},
    }


def test_two_create_goals_keep_the_last_one():
    proposals = parse_proposals(_block([_create("prop_old", "Old goal"), _create("prop_new", "New goal")]))

    goals = [p for p in proposals if p.action == "create_goal"]
    assert len(goals) == 1
    assert goals[0].id == "prop_new"
    assert goals[0].args["title"] == "New goal"


def test_milestones_pointing_at_a_dropped_goal_are_repointed():
    proposals = parse_proposals(
        _block(
            [
                _create("prop_old", "Old goal"),
                _milestone("prop_m1", "Apply", "Old goal"),
                _create("prop_new", "New goal"),
                _milestone("prop_m2", "Interview", "New goal"),
            ]
        )
    )

    milestones = {p.id: p for p in proposals if p.action == "add_milestone"}
    assert milestones["prop_m1"].args["goal_title"] == "New goal"
    assert milestones["prop_m2"].args["goal_title"] == "New goal"


def test_a_single_create_goal_is_left_alone():
    proposals = parse_proposals(_block([_create("prop_one", "Only goal"), _milestone("prop_m1", "Apply", "Only goal")]))

    assert [p.id for p in proposals if p.action == "create_goal"] == ["prop_one"]
    assert proposals[1].args["goal_title"] == "Only goal"
