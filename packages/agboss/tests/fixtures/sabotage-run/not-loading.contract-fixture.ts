// #831: a sabotage fixture that throws while it registers: runConformanceSabotage must not hand
// back a run to assert on.
throw new Error("this fixture does not load");
