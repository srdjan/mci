import Foundation

let fixtureDirectory = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1] : defaultFixtureDirectory()

checkDecodeFixtures(directory: fixtureDirectory)
checkSnapshotFixtures()
checkTimestamps()
checkStatusFiles()
checkDisplay()
checkText()
checkAnsi()
checkLogReader()
finish()
