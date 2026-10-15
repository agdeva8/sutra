"""When to ask the user for material, and how. One definition, used by the goal intake and by the coach."""
from __future__ import annotations

SOURCE_REQUEST_RULES = """Material that would make the plan better: when the goal depends on a document the person probably has, ask for that exact document by name, say in a few words what you will do with it, and let them skip.
- An exam or course: the exam timetable and the syllabus (a PDF or a photo), so each paper lands on its date and each unit becomes tasks.
- A health or fitness goal: recent reports, a prescription or a diet chart, so the plan fits what is actually advised.
- A job switch: their current resume and the job posts they are aiming at.
- A move, visa or paperwork: the checklist or letter from the office.
- A project or assignment: the brief or scope document.
Ask for it as one of your numbered questions, written as a real question that ends in "?" ("Do you have your exam timetable and syllabus?"), with the options "I'll upload it" and "I don't have it" (and "I'll paste a link" where a link makes sense). Never ask generically ("any documents?"): name the thing. Never ask for something the ATTACHED SOURCES already contain, and ask for only one kind of material per round."""
