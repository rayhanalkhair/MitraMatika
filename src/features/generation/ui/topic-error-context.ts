"use client";

import { createContext } from "react";

// The generation form provides the id of the element that shows the topic error, only while there
// is one, so the topic list can point to it with aria-describedby.
export const TopicErrorContext = createContext<string | undefined>(undefined);
