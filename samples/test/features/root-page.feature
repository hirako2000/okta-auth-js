Feature: Root page for Direct Auth Demo Application

  Background:

    Scenario: Mary visits the Root View WITHOUT an authentcation session (no tokens)
      Given Mary navigates to the Root View
      Then the Root Page shows links to the Entry Points

    Scenario: Mary logs out of the app
      Given Mary has an authentcation session
        And Mary navigates to the Root View
      When Mary clicks the logout button
      Then she is redirected back to the Root View
        And Mary sees login, registration buttons
        And she sees that claims from /userinfo are disappeared
