import Foundation

let fixtureDirectory = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1] : defaultFixtureDirectory()

checkDecodeFixtures(directory: fixtureDirectory)
checkTimestamps()
checkStatusFiles()
await checkDisplay()
await checkProcessParsing()
checkRegistry()
checkText()
checkAnsi()
checkLogReader()
finish()
